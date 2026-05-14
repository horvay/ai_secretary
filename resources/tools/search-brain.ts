#!/usr/bin/env bun
/**
 * Search Ari's local brain using GBrain-inspired page/chunk semantics.
 * This is intentionally backed by AI Secretary's local SQLite/profile files so
 * Pi can use brain-style retrieval without requiring an external gbrain binary.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

function getDataDir(): string {
  const override = process.env.AI_SECRETARY_DATA_DIR?.trim();
  if (override) return override;
  if (process.platform === "win32" && process.env.LOCALAPPDATA?.trim()) {
    return join(process.env.LOCALAPPDATA, ".ai-secretary");
  }
  return join(homedir(), ".ai-secretary");
}

function findDataDir() {
  return getDataDir();
}

function parseArgs(args: string[]) {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;
    const key = args[i].slice(2);
    const value = i + 1 < args.length && !args[i + 1].startsWith("--") ? args[i + 1] : "true";
    parsed[key] = value;
    if (value !== "true") i++;
  }
  return parsed;
}

function readBooleanSetting(db: Database, key: string, fallback: boolean) {
  const row = db.query("SELECT value FROM app_state WHERE key = ? LIMIT 1").get(key) as { value?: string } | null;
  if (!row?.value) return fallback;
  try {
    const parsed = JSON.parse(row.value);
    return typeof parsed === "boolean" ? parsed : fallback;
  } catch {
    const lower = row.value.trim().toLowerCase();
    if (lower === "1" || lower === "true") return true;
    if (lower === "0" || lower === "false") return false;
    return fallback;
  }
}

function readStringArraySetting(db: Database, key: string) {
  const row = db.query("SELECT value FROM app_state WHERE key = ? LIMIT 1").get(key) as { value?: string } | null;
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function redact(text: string, terms: string[]) {
  let result = text;
  for (const term of terms) {
    const trimmed = term.trim();
    if (trimmed) result = result.replaceAll(trimmed, "[REDACTED]");
  }
  return result;
}

function toFtsQuery(query: string) {
  const terms = query
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`);
  return terms.join(" OR ") || '""';
}

function snippet(content: string, query: string) {
  const compact = content.replace(/\s+/g, " ").trim();
  const lower = compact.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  let index = -1;
  for (const term of terms) {
    const pos = lower.indexOf(term);
    if (pos !== -1 && (index === -1 || pos < index)) index = pos;
  }
  if (index === -1) return compact.slice(0, 240);
  const start = Math.max(0, index - 80);
  const end = Math.min(compact.length, index + 180);
  return `${start > 0 ? "..." : ""}${compact.slice(start, end)}${end < compact.length ? "..." : ""}`;
}

const [, , ...rest] = process.argv;
const args = parseArgs(rest);
const query = (args.query ?? args.q ?? rest.find((value) => !value.startsWith("--")) ?? "").trim();
const ftsQuery = toFtsQuery(query);
const limit = Math.max(1, Math.min(20, Number.parseInt(args.limit ?? "8", 10) || 8));
const json = args.json === "true";

if (!query) {
  console.log('Usage: bun resources/tools/search-brain.ts --query "keyword phrase" [--limit 8] [--json]');
  process.exit(1);
}

const dataDir = findDataDir();
const dbPath = join(dataDir, "memory", "memory.db");
if (!existsSync(dbPath)) {
  console.log(`Error: memory database not found at ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
if (!readBooleanSetting(db, "memory.enabled", true)) {
  console.log("Memory is disabled.");
  process.exit(0);
}

const redactedTerms = readStringArraySetting(db, "privacy.redactedTerms");
const results: Array<{
  slug: string;
  title: string;
  type: string;
  chunk_text: string;
  chunk_source: string;
  score: number;
}> = [];

const profilePath = join(dataDir, "memory", "user_profile.md");
if (existsSync(profilePath)) {
  const content = readFileSync(profilePath, "utf8");
  if (content.toLowerCase().includes(query.toLowerCase()) || query.toLowerCase().split(/\s+/).some((term) => content.toLowerCase().includes(term))) {
    results.push({
      slug: "people/user",
      title: "User Profile",
      type: "person",
      chunk_text: redact(snippet(content, query), redactedTerms),
      chunk_source: "compiled_truth",
      score: 0,
    });
  }
}

try {
  const rows = db.query(`
    SELECT daily_summaries.date AS date, daily_summaries.summary AS summary, daily_summaries.interaction_count AS interaction_count, bm25(daily_summaries_fts) AS rank
    FROM daily_summaries
    JOIN daily_summaries_fts ON daily_summaries_fts.rowid = daily_summaries.id
    WHERE daily_summaries_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(ftsQuery, limit) as Array<{ date: string; summary: string; interaction_count: number; rank: number }>;
  for (const row of rows) {
    results.push({
      slug: `daily/${row.date}`,
      title: `Daily Summary ${row.date}`,
      type: "daily_summary",
      chunk_text: redact(snippet(row.summary, query), redactedTerms),
      chunk_source: "compiled_truth",
      score: row.rank,
    });
  }
} catch {
  // Older DBs may not have summary FTS; skip.
}

try {
  const rows = db.query(`
    SELECT i.*, bm25(interactions_fts) AS rank
    FROM interactions i
    JOIN interactions_fts ON interactions_fts.rowid = i.id
    WHERE interactions_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(ftsQuery, limit) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const id = Number(row.id ?? 0);
    const role = String(row.role ?? "unknown");
    const timestamp = Number(row.timestamp ?? Date.now());
    const content = String(row.content ?? "");
    results.push({
      slug: `memory/interactions/${id}`,
      title: `${role} memory ${new Date(timestamp).toLocaleString()}`,
      type: "interaction",
      chunk_text: redact(snippet(content, query), redactedTerms),
      chunk_source: "timeline",
      score: Number(row.rank ?? 0),
    });
  }
} catch (error) {
  console.log(`Search failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const limited = results.slice(0, limit);
if (json) {
  console.log(JSON.stringify(limited, null, 2));
} else if (limited.length === 0) {
  console.log("No matching brain context found.");
} else {
  console.log(`Found ${limited.length} brain result(s):\n`);
  for (const result of limited) {
    console.log(`- ${result.slug} (${result.type})`);
    console.log(`  title: ${result.title}`);
    console.log(`  source: ${result.chunk_source}`);
    console.log(`  snippet: ${result.chunk_text}`);
    console.log();
  }
}
