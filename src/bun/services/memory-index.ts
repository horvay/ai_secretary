/**
 * Memory Index Service for Ari
 * Provides search and retrieval capabilities for conversation history
 */

import { getDatabase, type Interaction, type DailySummary } from "../db";
import { getSetting } from "./app-state";
import { logDebug } from "../utils/logger";

function isMemoryReadable() {
  return getSetting("memory.enabled");
}

function redactText(text: string) {
  const redactedTerms = getSetting("privacy.redactedTerms");
  let result = text;
  for (const term of redactedTerms) {
    const trimmed = term.trim();
    if (!trimmed) continue;
    result = result.replaceAll(trimmed, "[REDACTED]");
  }
  return result;
}

/**
 * Search result with relevance info
 */
export interface SearchResult {
  interaction: Interaction;
  relevance: number;
  snippet: string;
}

/**
 * Time range presets
 */
export type TimeRange = "today" | "yesterday" | "this_week" | "last_week" | "this_month" | "all";

/**
 * Get timestamp for start of a time range
 */
function getTimeRangeStart(range: TimeRange): number {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (range) {
    case "today":
      return today.getTime();

    case "yesterday": {
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      return yesterday.getTime();
    }

    case "this_week": {
      const startOfWeek = new Date(today);
      startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
      return startOfWeek.getTime();
    }

    case "last_week": {
      const lastWeekStart = new Date(today);
      lastWeekStart.setDate(lastWeekStart.getDate() - lastWeekStart.getDay() - 7);
      return lastWeekStart.getTime();
    }

    case "this_month":
      return new Date(now.getFullYear(), now.getMonth(), 1).getTime();

    case "all":
    default:
      return 0;
  }
}

/**
 * Get timestamp for end of a time range
 */
function getTimeRangeEnd(range: TimeRange): number {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (range) {
    case "yesterday":
      return today.getTime() - 1; // End of yesterday

    case "last_week": {
      const thisWeekStart = new Date(today);
      thisWeekStart.setDate(thisWeekStart.getDate() - thisWeekStart.getDay());
      return thisWeekStart.getTime() - 1;
    }

    default:
      return Date.now();
  }
}

/**
 * Full-text search across interactions
 */
export function searchInteractions(
  query: string,
  options?: {
    limit?: number;
    timeRange?: TimeRange;
    role?: "user" | "assistant";
  }
): SearchResult[] {
  if (!isMemoryReadable()) {
    return [];
  }

  const db = getDatabase();
  const limit = options?.limit ?? 50;

  let sql = `
    SELECT i.*, bm25(interactions_fts) as rank
    FROM interactions i
    JOIN interactions_fts fts ON i.id = fts.rowid
    WHERE interactions_fts MATCH ?
  `;
  const params: (string | number)[] = [query];

  if (options?.timeRange && options.timeRange !== "all") {
    const startTime = getTimeRangeStart(options.timeRange);
    const endTime = getTimeRangeEnd(options.timeRange);
    sql += " AND i.timestamp >= ? AND i.timestamp <= ?";
    params.push(startTime, endTime);
  }

  if (options?.role) {
    sql += " AND i.role = ?";
    params.push(options.role);
  }

  sql += " ORDER BY rank LIMIT ?";
  params.push(limit);

  const results = db.query(sql).all(...params) as (Interaction & { rank: number })[];

  return results.map((row) => {
    const redactedContent = redactText(row.content);
    return {
      interaction: {
        ...row,
        content: redactedContent,
      },
      relevance: -row.rank,
      snippet: createSnippet(redactedContent, query),
    };
  });
}

/**
 * Create a snippet highlighting the search terms
 */
function createSnippet(content: string, query: string, maxLength: number = 150): string {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const terms = lowerQuery.split(/\s+/).filter((t) => t.length > 2);

  let bestPos = -1;
  for (const term of terms) {
    const pos = lowerContent.indexOf(term);
    if (pos !== -1 && (bestPos === -1 || pos < bestPos)) {
      bestPos = pos;
    }
  }

  if (bestPos === -1) {
    return content.slice(0, maxLength) + (content.length > maxLength ? "..." : "");
  }

  const start = Math.max(0, bestPos - 50);
  const end = Math.min(content.length, bestPos + maxLength - 50);
  let snippet = content.slice(start, end);

  if (start > 0) snippet = "..." + snippet;
  if (end < content.length) snippet = snippet + "...";

  return snippet;
}

/**
 * Search by time range (without text query)
 */
export function getInteractionsByTimeRange(
  timeRange: TimeRange,
  options?: {
    limit?: number;
    role?: "user" | "assistant";
  }
): Interaction[] {
  if (!isMemoryReadable()) {
    return [];
  }

  const db = getDatabase();
  const startTime = getTimeRangeStart(timeRange);
  const endTime = getTimeRangeEnd(timeRange);
  const limit = options?.limit ?? 100;

  let sql = "SELECT * FROM interactions WHERE timestamp >= ? AND timestamp <= ?";
  const params: (string | number)[] = [startTime, endTime];

  if (options?.role) {
    sql += " AND role = ?";
    params.push(options.role);
  }

  sql += " ORDER BY timestamp DESC LIMIT ?";
  params.push(limit);

  return (db.query(sql).all(...params) as Interaction[]).map((interaction) => ({
    ...interaction,
    content: redactText(interaction.content),
  }));
}

/**
 * Get conversation context (interactions before and after a specific one)
 */
export function getConversationContext(
  interactionId: number,
  contextSize: number = 5
): Interaction[] {
  if (!isMemoryReadable()) {
    return [];
  }

  const db = getDatabase();
  const target = db
    .query("SELECT timestamp FROM interactions WHERE id = ?")
    .get(interactionId) as { timestamp: number } | null;

  if (!target) {
    return [];
  }

  const before = db
    .query(
      `SELECT * FROM interactions
       WHERE timestamp < ?
       ORDER BY timestamp DESC
       LIMIT ?`
    )
    .all(target.timestamp, contextSize) as Interaction[];

  const after = db
    .query(
      `SELECT * FROM interactions
       WHERE timestamp >= ?
       ORDER BY timestamp ASC
       LIMIT ?`
    )
    .all(target.timestamp, contextSize + 1) as Interaction[];

  return [...before.reverse(), ...after]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((interaction) => ({
      ...interaction,
      content: redactText(interaction.content),
    }));
}

/**
 * Get recent conversations grouped by session
 */
export function getRecentSessions(limit: number = 10): {
  sessionId: string | null;
  startTime: number;
  endTime: number;
  messageCount: number;
  preview: string;
}[] {
  if (!isMemoryReadable()) {
    return [];
  }

  const db = getDatabase();

  const results = db
    .query(
      `SELECT
         session_id,
         MIN(timestamp) as start_time,
         MAX(timestamp) as end_time,
         COUNT(*) as message_count,
         (SELECT content FROM interactions i2
          WHERE i2.session_id = interactions.session_id
          ORDER BY timestamp ASC LIMIT 1) as first_message
       FROM interactions
       GROUP BY session_id
       ORDER BY MAX(timestamp) DESC
       LIMIT ?`
    )
    .all(limit) as {
    session_id: string | null;
    start_time: number;
    end_time: number;
    message_count: number;
    first_message: string;
  }[];

  return results.map((r) => ({
    sessionId: r.session_id,
    startTime: r.start_time,
    endTime: r.end_time,
    messageCount: r.message_count,
    preview: redactText(r.first_message?.slice(0, 100) || ""),
  }));
}

/**
 * Find similar past conversations (basic keyword matching)
 */
export function findSimilarConversations(
  text: string,
  limit: number = 5
): SearchResult[] {
  const keywords = text
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3)
    .slice(0, 10);

  if (keywords.length === 0) {
    return [];
  }

  const query = keywords.join(" OR ");
  return searchInteractions(query, { limit });
}

/**
 * Get daily summary for natural language queries
 */
export function findDailySummary(description: string): DailySummary | null {
  if (!isMemoryReadable()) {
    return null;
  }

  const db = getDatabase();
  const lower = description.toLowerCase();
  let targetDate: string | null = null;

  if (lower.includes("today")) {
    targetDate = new Date().toISOString().split("T")[0];
  } else if (lower.includes("yesterday")) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    targetDate = yesterday.toISOString().split("T")[0];
  } else {
    const dateMatch = description.match(/\d{4}-\d{2}-\d{2}/);
    if (dateMatch) {
      targetDate = dateMatch[0];
    }
  }

  if (!targetDate) {
    return null;
  }

  return db
    .query("SELECT * FROM daily_summaries WHERE date = ?")
    .get(targetDate) as DailySummary | null;
}

/**
 * Get answer candidates for a question by searching memory
 */
export function findAnswerCandidates(
  question: string,
  limit: number = 10
): { context: string; sources: SearchResult[] } {
  const results = searchInteractions(question, { limit });

  if (results.length === 0) {
    return {
      context: "No relevant past conversations found.",
      sources: [],
    };
  }

  const contextParts = results.map((r) => {
    const date = new Date(r.interaction.timestamp).toLocaleDateString();
    const role = r.interaction.role === "user" ? "User" : r.interaction.role === "assistant" ? "Ari" : r.interaction.role;
    return `[${date}] ${role}: ${r.snippet}`;
  });

  return {
    context: `Relevant past conversations:\n${contextParts.join("\n")}`,
    sources: results,
  };
}

/**
 * Rebuild the FTS index (for maintenance)
 */
export function rebuildFtsIndex(): void {
  const db = getDatabase();

  logDebug("[MemoryIndex] Rebuilding FTS index...");

  db.exec("DELETE FROM interactions_fts");
  db.exec("INSERT INTO interactions_fts(rowid, content) SELECT id, content FROM interactions");

  logDebug("[MemoryIndex] FTS index rebuilt");
}
