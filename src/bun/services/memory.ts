/**
 * Memory Service for Ari
 * Core service that logs all interactions and manages the memory system
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join } from "path";
import { writeFile, mkdir, readFile, readdir, rm, access, copyFile } from "fs/promises";
import { constants } from "fs";
import { createHash } from "crypto";
import {
  initDatabase,
  getDatabase,
  closeDatabase,
  runMigrations,
  getScreenshotsDir,
  getMemoryDir,
  getUserProfilePath,
  type Interaction,
  type InteractionType,
  type DailySummary,
  type Screenshot,
} from "../db";
import { getSetting, setSetting } from "./app-state";
import { logInfo, logError, logDebug, logWarn } from "../utils/logger";

/**
 * Memory service state
 */
interface MemoryState {
  initialized: boolean;
  db: Database | null;
}

const state: MemoryState = {
  initialized: false,
  db: null,
};

/**
 * Initialize the memory service
 */
export async function initMemory(): Promise<void> {
  if (state.initialized) {
    logDebug("[Memory] Already initialized");
    return;
  }

  try {
    logInfo("[Memory] Initializing memory service...");

    // Initialize database
    state.db = await initDatabase();

    // Run any pending migrations
    runMigrations(state.db);
    const retentionCleared = applyMemoryRetentionPolicy();
    if (retentionCleared > 0) {
      logInfo(`[Memory] Applied retention policy and cleared ${retentionCleared} old interaction(s)`);
    }

    state.initialized = true;
    logInfo("[Memory] Memory service initialized successfully");
  } catch (error) {
    logError("[Memory] Failed to initialize memory service:", error);

    const errorMessage = error instanceof Error ? error.message : String(error);
    const isCorruption = /malformed|corrupt|not a database|file is not a database|database disk image/i.test(errorMessage);
    if (!isCorruption) {
      throw error;
    }

    const memoryDir = getMemoryDir();
    const dbPath = join(memoryDir, "memory.db");
    const shmPath = `${dbPath}-shm`;
    const walPath = `${dbPath}-wal`;
    if (existsSync(dbPath)) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupBase = join(memoryDir, `memory.recovery-backup.${timestamp}`);
      try {
        closeDatabase();
        state.db = null;
        await copyFile(dbPath, `${backupBase}.db`);
        if (existsSync(walPath)) await copyFile(walPath, `${backupBase}.db-wal`);
        if (existsSync(shmPath)) await copyFile(shmPath, `${backupBase}.db-shm`);
        await rm(dbPath, { force: true });
        await rm(shmPath, { force: true });
        await rm(walPath, { force: true });
        logInfo("[Memory] Attempting corruption recovery by recreating database from scratch. Backup base:", backupBase);
        state.db = await initDatabase();
        runMigrations(state.db);
        state.initialized = true;
        logWarn("[Memory] Database corruption recovery succeeded");
        return;
      } catch (recoveryError) {
        logError("[Memory] Corruption recovery attempt failed:", recoveryError);
      }
    }

    throw error;
  }
}

/**
 * Check if memory service is initialized
 */
export function isMemoryInitialized(): boolean {
  return state.initialized;
}

/**
 * Shutdown the memory service
 */
export function shutdownMemory(): void {
  if (!state.initialized) {
    return;
  }

  closeDatabase();
  state.db = null;
  state.initialized = false;
  logInfo("[Memory] Memory service shut down");
}

export interface MemorySettings {
  enabled: boolean;
  conversationLoggingEnabled: boolean;
  screenshotLoggingEnabled: boolean;
  ocrEnabled: boolean;
  retentionDays: number | null;
  profileLearningEnabled: boolean;
  redactedTerms: string[];
}

export type MemoryClearSegment =
  | "all"
  | "conversations"
  | "screenshots"
  | "summaries"
  | "profile"
  | "tasks"
  | "reminders"
  | "routines"
  | "lists";

function redactSensitiveText(text: string): string {
  const redactedTerms = getSetting("privacy.redactedTerms");
  if (redactedTerms.length === 0) return text;

  let result = text;
  for (const term of redactedTerms) {
    const trimmed = term.trim();
    if (!trimmed) continue;
    result = result.replaceAll(trimmed, "[REDACTED]");
  }
  return result;
}

export function getMemorySettings(): MemorySettings {
  return {
    enabled: getSetting("memory.enabled"),
    conversationLoggingEnabled: getSetting("memory.conversationLoggingEnabled"),
    screenshotLoggingEnabled: getSetting("memory.screenshotLoggingEnabled"),
    ocrEnabled: getSetting("memory.ocrEnabled"),
    retentionDays: getSetting("memory.retentionDays"),
    profileLearningEnabled: getSetting("memory.profileLearningEnabled"),
    redactedTerms: getSetting("privacy.redactedTerms"),
  };
}

export function updateMemorySettings(settings: Partial<MemorySettings>): MemorySettings {
  if (settings.enabled !== undefined) setSetting("memory.enabled", settings.enabled);
  if (settings.conversationLoggingEnabled !== undefined) setSetting("memory.conversationLoggingEnabled", settings.conversationLoggingEnabled);
  if (settings.screenshotLoggingEnabled !== undefined) setSetting("memory.screenshotLoggingEnabled", settings.screenshotLoggingEnabled);
  if (settings.ocrEnabled !== undefined) setSetting("memory.ocrEnabled", settings.ocrEnabled);
  if (settings.retentionDays !== undefined) setSetting("memory.retentionDays", settings.retentionDays);
  if (settings.profileLearningEnabled !== undefined) setSetting("memory.profileLearningEnabled", settings.profileLearningEnabled);
  if (settings.redactedTerms !== undefined) setSetting("privacy.redactedTerms", settings.redactedTerms);
  return getMemorySettings();
}

export function isConversationMemoryEnabled(): boolean {
  const settings = getMemorySettings();
  return settings.enabled && settings.conversationLoggingEnabled;
}

function shouldPersistInteraction(type: InteractionType): boolean {
  const settings = getMemorySettings();
  if (!settings.enabled) return false;
  if ((type === "text" || type === "voice" || type === "context") && !settings.conversationLoggingEnabled) return false;
  if (type === "screenshot" && !settings.screenshotLoggingEnabled) return false;
  return true;
}

// ============================================================================
// Interaction Logging
// ============================================================================

/**
 * Log an interaction
 */
export function logInteraction(params: {
  type: InteractionType;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  sessionId?: string;
  turnId?: string;
  sequence?: number;
  kind?: "message" | "screenshot" | "ocr" | "context" | "tool_call" | "tool_result" | "summary";
  modality?: "text" | "voice" | "image" | "audio";
  source?: string;
  metadata?: Record<string, unknown>;
}): number | null {
  if (!shouldPersistInteraction(params.type)) {
    logDebug("[Memory] Skipping interaction due to memory settings:", params.type, params.role);
    return null;
  }

  const db = getDatabase();
  const now = Date.now();
  const d = new Date(now);
  const dateInt = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); // YYYYMMDD as integer
  const content = redactSensitiveText(params.content);
  const metadata = params.metadata ? JSON.parse(JSON.stringify(params.metadata)) as Record<string, unknown> : null;
  if (metadata && typeof metadata.ocrText === "string") {
    metadata.ocrText = redactSensitiveText(metadata.ocrText);
  }

  const result = db
    .query(
      `INSERT INTO interactions (type, role, content, session_id, turn_id, sequence, kind, modality, source, timestamp, date, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.type,
      params.role,
      content,
      params.sessionId ?? null,
      params.turnId ?? null,
      params.sequence ?? null,
      params.kind ?? "message",
      params.modality ?? params.type,
      params.source ?? null,
      now,
      dateInt,
      metadata ? JSON.stringify(metadata) : null
    );

  logDebug("[Memory] Logged interaction:", params.type, params.role, "id:", result.lastInsertRowid);
  return Number(result.lastInsertRowid);
}

/**
 * Get interactions by time range
 */
export function getInteractions(params: {
  startTime?: number;
  endTime?: number;
  type?: InteractionType;
  role?: "user" | "assistant";
  limit?: number;
  offset?: number;
}): Interaction[] {
  const db = getDatabase();

  let query = "SELECT * FROM interactions WHERE 1=1";
  const queryParams: (string | number)[] = [];

  if (params.startTime !== undefined) {
    query += " AND timestamp >= ?";
    queryParams.push(params.startTime);
  }

  if (params.endTime !== undefined) {
    query += " AND timestamp <= ?";
    queryParams.push(params.endTime);
  }

  if (params.type) {
    query += " AND type = ?";
    queryParams.push(params.type);
  }

  if (params.role) {
    query += " AND role = ?";
    queryParams.push(params.role);
  }

  query += " ORDER BY timestamp DESC";

  if (params.limit) {
    query += " LIMIT ?";
    queryParams.push(params.limit);
  }

  if (params.offset) {
    query += " OFFSET ?";
    queryParams.push(params.offset);
  }

  return db.query(query).all(...queryParams) as Interaction[];
}

/**
 * Get today's interactions
 */
export function getTodaysInteractions(): Interaction[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startOfDay = today.getTime();

  return getInteractions({ startTime: startOfDay });
}

/**
 * Get interaction count
 */
export function getInteractionCount(params?: {
  startTime?: number;
  endTime?: number;
  type?: InteractionType;
}): number {
  const db = getDatabase();

  let query = "SELECT COUNT(*) as count FROM interactions WHERE 1=1";
  const queryParams: (string | number)[] = [];

  if (params?.startTime !== undefined) {
    query += " AND timestamp >= ?";
    queryParams.push(params.startTime);
  }

  if (params?.endTime !== undefined) {
    query += " AND timestamp <= ?";
    queryParams.push(params.endTime);
  }

  if (params?.type) {
    query += " AND type = ?";
    queryParams.push(params.type);
  }

  const result = db.query(query).get(...queryParams) as { count: number };
  return result.count;
}

// ============================================================================
// Screenshot Management
// ============================================================================

/**
 * Generate a screenshot file key
 */
export function generateScreenshotKey(): string {
  const timestamp = Date.now();
  const hash = createHash("md5").update(`${timestamp}-${Math.random()}`).digest("hex").slice(0, 8);
  return `screenshot_image_${timestamp}-${hash}.png`;
}

/**
 * Save a screenshot and log it
 */
export async function saveScreenshot(params: {
  imageData: Buffer | string; // Buffer or base64 string
  ocrText?: string;
  width?: number;
  height?: number;
  sessionId?: string;
  turnId?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ fileKey: string; id: number }> {
  const settings = getMemorySettings();
  if (!settings.enabled || !settings.screenshotLoggingEnabled) {
    throw new Error("Screenshot logging is disabled by current memory settings.");
  }

  const db = getDatabase();
  const fileKey = generateScreenshotKey();
  const screenshotsDir = getScreenshotsDir();

  // Ensure screenshots directory exists
  await mkdir(screenshotsDir, { recursive: true });

  // Convert base64 to buffer if needed
  let imageBuffer: Buffer;
  if (typeof params.imageData === "string") {
    // Remove data URL prefix if present
    const base64Data = params.imageData.replace(/^data:image\/\w+;base64,/, "");
    imageBuffer = Buffer.from(base64Data, "base64");
  } else {
    imageBuffer = params.imageData;
  }

  // Save image file
  const filePath = join(screenshotsDir, fileKey);
  await writeFile(filePath, imageBuffer);

  // Insert into database
  const result = db
    .query(
      `INSERT INTO screenshots (file_key, ocr_text, session_id, turn_id, timestamp, width, height, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      fileKey,
      settings.ocrEnabled ? redactSensitiveText(params.ocrText ?? "") || null : null,
      params.sessionId ?? null,
      params.turnId ?? null,
      Date.now(),
      params.width ?? null,
      params.height ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null
    );

  logDebug("[Memory] Saved screenshot:", fileKey);

  // Also log as an interaction
  logInteraction({
    type: "screenshot",
    role: "user",
    content: fileKey,
    sessionId: params.sessionId,
    turnId: params.turnId,
    sequence: 0,
    kind: "screenshot",
    modality: "image",
    source: params.source ?? "screenshot",
    metadata: { ocrText: settings.ocrEnabled ? params.ocrText : null, width: params.width, height: params.height },
  });

  return {
    fileKey,
    id: Number(result.lastInsertRowid),
  };
}

/**
 * Get screenshot by file key
 */
export function getScreenshot(fileKey: string): Screenshot | null {
  const db = getDatabase();
  return db.query("SELECT * FROM screenshots WHERE file_key = ?").get(fileKey) as Screenshot | null;
}

/**
 * Get all screenshots
 */
export function getScreenshots(params?: {
  limit?: number;
  offset?: number;
}): Screenshot[] {
  const db = getDatabase();

  let query = "SELECT * FROM screenshots ORDER BY timestamp DESC";
  const queryParams: number[] = [];

  if (params?.limit) {
    query += " LIMIT ?";
    queryParams.push(params.limit);
  }

  if (params?.offset) {
    query += " OFFSET ?";
    queryParams.push(params.offset);
  }

  return db.query(query).all(...queryParams) as Screenshot[];
}

/**
 * Update screenshot OCR text
 */
export function updateScreenshotOcr(fileKey: string, ocrText: string): void {
  const db = getDatabase();
  db.query("UPDATE screenshots SET ocr_text = ? WHERE file_key = ?").run(ocrText, fileKey);
  logDebug("[Memory] Updated OCR for screenshot:", fileKey);
}

// ============================================================================
// Daily Summaries
// ============================================================================

/**
 * Get or create today's date string
 */
function getTodayDateString(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Save or update a daily summary
 */
export function saveDailySummary(params: {
  date?: string; // YYYY-MM-DD, defaults to today
  summary: string;
  interactionCount?: number;
}): number {
  const db = getDatabase();
  const date = params.date ?? getTodayDateString();

  // Check if summary exists for this date
  const existing = db.query("SELECT id FROM daily_summaries WHERE date = ?").get(date) as { id: number } | null;

  if (existing) {
    // Update existing
    db.query(
      `UPDATE daily_summaries
       SET summary = ?, interaction_count = ?, updated_at = ?
       WHERE date = ?`
    ).run(params.summary, params.interactionCount ?? 0, Date.now(), date);
    logDebug("[Memory] Updated daily summary for:", date);
    return existing.id;
  } else {
    // Insert new
    const result = db
      .query(
        `INSERT INTO daily_summaries (date, summary, interaction_count)
         VALUES (?, ?, ?)`
      )
      .run(date, params.summary, params.interactionCount ?? 0);
    logDebug("[Memory] Created daily summary for:", date);
    return Number(result.lastInsertRowid);
  }
}

/**
 * Get daily summary for a specific date
 */
export function getDailySummary(date: string): DailySummary | null {
  const db = getDatabase();
  return db.query("SELECT * FROM daily_summaries WHERE date = ?").get(date) as DailySummary | null;
}

/**
 * Get recent daily summaries
 */
export function getRecentDailySummaries(limit: number = 7): DailySummary[] {
  const db = getDatabase();
  return db
    .query("SELECT * FROM daily_summaries ORDER BY date DESC LIMIT ?")
    .all(limit) as DailySummary[];
}

// ============================================================================
// Full-Text Search
// ============================================================================

/**
 * Search interactions by content
 */
export function searchInteractions(query: string, limit: number = 50): Interaction[] {
  const db = getDatabase();

  // Use FTS5 for search
  const results = db
    .query(
      `SELECT i.* FROM interactions i
       JOIN interactions_fts fts ON i.id = fts.rowid
       WHERE interactions_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(query, limit) as Interaction[];

  return results;
}

// ============================================================================
// Stats and Utilities
// ============================================================================

/**
 * Get memory stats
 */
export function getMemoryStats(): {
  totalInteractions: number;
  todayInteractions: number;
  totalScreenshots: number;
  totalDailySummaries: number;
  oldestInteraction: number | null;
  newestInteraction: number | null;
} {
  const db = getDatabase();

  const totalInteractions = (
    db.query("SELECT COUNT(*) as count FROM interactions").get() as { count: number }
  ).count;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayInteractions = (
    db.query("SELECT COUNT(*) as count FROM interactions WHERE timestamp >= ?").get(today.getTime()) as { count: number }
  ).count;

  const totalScreenshots = (
    db.query("SELECT COUNT(*) as count FROM screenshots").get() as { count: number }
  ).count;

  const totalDailySummaries = (
    db.query("SELECT COUNT(*) as count FROM daily_summaries").get() as { count: number }
  ).count;

  const oldest = db.query("SELECT MIN(timestamp) as ts FROM interactions").get() as { ts: number | null };
  const newest = db.query("SELECT MAX(timestamp) as ts FROM interactions").get() as { ts: number | null };

  return {
    totalInteractions,
    todayInteractions,
    totalScreenshots,
    totalDailySummaries,
    oldestInteraction: oldest.ts,
    newestInteraction: newest.ts,
  };
}

async function clearDirectoryContents(directory: string): Promise<void> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(entries.map((entry) => rm(join(directory, entry.name), { recursive: true, force: true })));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function clearProfileFile(): Promise<void> {
  try {
    await access(getUserProfilePath(), constants.F_OK);
    await writeFile(getUserProfilePath(), "# User Profile\n\n## Personal Info\n- Name:\n- Preferred name:\n- Location:\n\n## Preferences\n- Communication style:\n\n## Schedule Patterns\n- Timezone:\n\n## Interests\n\n## Important Relationships\n\n## Notes\n", "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function exportMemoryData(): Promise<string> {
  const db = getDatabase();
  const exportDir = join(getMemoryDir(), "exports");
  await mkdir(exportDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const exportPath = join(exportDir, `memory-export-${timestamp}.json`);
  const screenshots = db.query("SELECT * FROM screenshots ORDER BY timestamp DESC").all();
  const interactions = db.query("SELECT * FROM interactions ORDER BY timestamp DESC").all();
  const dailySummaries = db.query("SELECT * FROM daily_summaries ORDER BY date DESC").all();
  const profileRaw = await readFile(getUserProfilePath(), "utf8").catch(() => "");
  const tasks = db.query("SELECT * FROM tasks ORDER BY created_at DESC").all();
  const reminders = db.query("SELECT * FROM reminders ORDER BY due_at ASC").all();
  const routines = db.query("SELECT * FROM routines ORDER BY created_at DESC").all();
  const routineCompletions = db.query("SELECT * FROM routine_completions ORDER BY completed_at DESC").all();
  const lists = db.query("SELECT * FROM lists ORDER BY name ASC").all();
  const listItems = db.query("SELECT * FROM list_items ORDER BY list_id ASC, position ASC").all();
  const conversationSessions = db.query("SELECT * FROM conversation_sessions ORDER BY started_at DESC").all();
  const conversationTurns = db.query("SELECT * FROM conversation_turns ORDER BY started_at DESC").all();
  const appState = db.query("SELECT * FROM app_state ORDER BY key ASC").all();

  const payload = {
    exportedAt: new Date().toISOString(),
    settings: getMemorySettings(),
    stats: getMemoryStats(),
    interactions,
    screenshots,
    dailySummaries,
    profileRaw,
    tasks,
    reminders,
    routines,
    routineCompletions,
    lists,
    listItems,
    conversationSessions,
    conversationTurns,
    appState,
  };

  await writeFile(exportPath, JSON.stringify(payload, null, 2), "utf8");
  setSetting("memory.lastExportPath", exportPath);
  return exportPath;
}

export async function clearMemorySegment(segment: MemoryClearSegment): Promise<number> {
  const db = getDatabase();
  let cleared = 0;

  if (segment === "all" || segment === "conversations") {
    const result = db.query("DELETE FROM interactions").run();
    db.exec("DELETE FROM interactions_fts");
    db.query("DELETE FROM conversation_turns").run();
    db.query("DELETE FROM conversation_sessions").run();
    cleared += result.changes;
  }

  if (segment === "all" || segment === "screenshots") {
    const result = db.query("DELETE FROM screenshots").run();
    const interactionResult = db.query("DELETE FROM interactions WHERE type = 'screenshot' OR kind = 'screenshot' OR kind = 'ocr'").run();
    db.exec("DELETE FROM interactions_fts");
    db.exec("INSERT INTO interactions_fts(rowid, content) SELECT id, content FROM interactions");
    await clearDirectoryContents(getScreenshotsDir());
    cleared += result.changes + interactionResult.changes;
  }

  if (segment === "all" || segment === "summaries") {
    const result = db.query("DELETE FROM daily_summaries").run();
    cleared += result.changes;
  }

  if (segment === "all" || segment === "profile") {
    await clearProfileFile();
    cleared += 1;
  }

  if (segment === "all" || segment === "tasks") {
    const result = db.query("DELETE FROM tasks").run();
    cleared += result.changes;
  }

  if (segment === "all" || segment === "reminders") {
    const result = db.query("DELETE FROM reminders").run();
    cleared += result.changes;
  }

  if (segment === "all" || segment === "routines") {
    const completions = db.query("DELETE FROM routine_completions").run();
    const triggers = db.query("DELETE FROM routine_triggers").run();
    const routines = db.query("DELETE FROM routines").run();
    cleared += completions.changes + triggers.changes + routines.changes;
  }

  if (segment === "all" || segment === "lists") {
    const items = db.query("DELETE FROM list_items").run();
    const lists = db.query("DELETE FROM lists").run();
    cleared += items.changes + lists.changes;
  }

  setSetting("memory.lastClearedSegment", segment);
  logInfo(`[Memory] Cleared memory segment ${segment} (${cleared} row changes)`);
  return cleared;
}

export async function clearAllMemory(): Promise<void> {
  await clearMemorySegment("all");
}

export async function forgetLastConversationTurn(): Promise<string | null> {
  const db = getDatabase();
  const lastTurn = db
    .query(
      `SELECT ct.id, ct.session_id
       FROM conversation_turns ct
       JOIN interactions i ON i.turn_id = ct.id
       WHERE ct.source IN ('text', 'voice') AND i.role = 'user'
       ORDER BY ct.started_at DESC
       LIMIT 1`
    )
    .get() as { id: string; session_id: string } | null;

  if (!lastTurn) {
    return null;
  }

  const screenshots = db
    .query("SELECT file_key FROM screenshots WHERE turn_id = ?")
    .all(lastTurn.id) as { file_key: string }[];
  for (const screenshot of screenshots) {
    await rm(join(getScreenshotsDir(), screenshot.file_key), { force: true });
  }
  db.query("DELETE FROM screenshots WHERE turn_id = ?").run(lastTurn.id);

  db.query("DELETE FROM interactions WHERE turn_id = ?").run(lastTurn.id);
  db.exec("DELETE FROM interactions_fts");
  db.exec("INSERT INTO interactions_fts(rowid, content) SELECT id, content FROM interactions");
  db.query("DELETE FROM conversation_turns WHERE id = ?").run(lastTurn.id);
  const remainingTurns = db
    .query("SELECT COUNT(*) as count FROM conversation_turns WHERE session_id = ?")
    .get(lastTurn.session_id) as { count: number };
  if (remainingTurns.count === 0) {
    db.query("DELETE FROM conversation_sessions WHERE id = ?").run(lastTurn.session_id);
  }

  setSetting("memory.lastForgottenTurnId", lastTurn.id);
  logInfo("[Memory] Forgot last user-initiated conversation turn:", lastTurn.id);
  return lastTurn.id;
}

export function applyMemoryRetentionPolicy(): number {
  const settings = getMemorySettings();
  const retentionDays = settings.retentionDays;
  if (!retentionDays || retentionDays <= 0) return 0;

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  return clearOldInteractions(cutoff);
}

/**
 * Clear interactions older than a certain date
 */
export function clearOldInteractions(beforeTimestamp: number): number {
  const db = getDatabase();

  const result = db
    .query("DELETE FROM interactions WHERE timestamp < ?")
    .run(beforeTimestamp);

  db.query(`
    DELETE FROM conversation_turns
    WHERE id NOT IN (SELECT DISTINCT turn_id FROM interactions WHERE turn_id IS NOT NULL)
  `).run();
  db.query(`
    DELETE FROM conversation_sessions
    WHERE id NOT IN (SELECT DISTINCT session_id FROM interactions WHERE session_id IS NOT NULL)
  `).run();

  logInfo("[Memory] Cleared", result.changes, "old interactions");
  return result.changes;
}

