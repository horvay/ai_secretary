#!/usr/bin/env bun
/** Search Ari's memory without exposing raw SQL. */

import { Database } from "bun:sqlite";
import { join } from "path";
import { existsSync } from "fs";
import { homedir } from "os";

function getDataDir(): string {
  const override = process.env.AI_SECRETARY_DATA_DIR?.trim();
  if (override) return override;
  if (process.platform === "win32" && process.env.LOCALAPPDATA?.trim()) {
    return join(process.env.LOCALAPPDATA, ".ai-secretary");
  }
  return join(homedir(), ".ai-secretary");
}

function findDbPath() {
  return join(getDataDir(), "memory", "memory.db");
}

function parseArgs(args: string[]) {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;
    const key = args[i].slice(2);
    const value = args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : "true";
    parsed[key] = value;
    if (value !== "true") i++;
  }
  return parsed;
}

function createSnippet(content: string, query: string) {
  const lower = content.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  let index = -1;
  for (const term of terms) {
    const pos = lower.indexOf(term);
    if (pos !== -1 && (index === -1 || pos < index)) index = pos;
  }
  if (index === -1) return content.slice(0, 160);
  const start = Math.max(0, index - 50);
  const end = Math.min(content.length, index + 110);
  return `${start > 0 ? "..." : ""}${content.slice(start, end)}${end < content.length ? "..." : ""}`;
}

const dbPath = findDbPath();
if (!existsSync(dbPath)) {
  console.log(`Error: Database not found at ${dbPath}`);
  process.exit(1);
}
const db = new Database(dbPath, { readonly: true });
const [, , ...rest] = process.argv;
const args = parseArgs(rest);
const query = (args.query ?? args.q ?? rest.find((value) => !value.startsWith("--")) ?? "").trim();
const limit = Math.max(1, Math.min(50, Number.parseInt(args.limit ?? "10", 10) || 10));
const role = args.role?.trim();
const session = args.session?.trim();

if (!query) {
  console.log('Usage: bun resources/tools/search-memory.ts --query "keyword phrase" [--limit 10] [--role user|assistant] [--session <id>]');
  process.exit(1);
}

let sql = `
  SELECT i.*, bm25(interactions_fts) AS rank
  FROM interactions i
  JOIN interactions_fts ON interactions_fts.rowid = i.id
  WHERE interactions_fts MATCH ?
`;
const params: (string | number)[] = [query];

if (role) {
  sql += " AND i.role = ?";
  params.push(role);
}
if (session) {
  sql += " AND i.session_id = ?";
  params.push(session);
}

sql += " ORDER BY rank LIMIT ?";
params.push(limit);

const readBooleanSetting = (key: string, fallback: boolean) => {
  const row = db.query("SELECT value FROM app_state WHERE key = ? LIMIT 1").get(key) as { value?: string } | null;
  if (!row?.value) return fallback;
  try {
    const parsed = JSON.parse(row.value);
    return typeof parsed === "boolean" ? parsed : fallback;
  } catch {
    const lower = row.value.trim().toLowerCase();
    return lower === "1" || lower === "true" ? true : lower === "0" || lower === "false" ? false : fallback;
  }
};

if (!readBooleanSetting("memory.enabled", true)) {
  console.log("Memory is disabled.");
  process.exit(0);
}

const redactionRow = db.query("SELECT value FROM app_state WHERE key = 'privacy.redactedTerms' LIMIT 1").get() as { value?: string } | null;
let redactedTerms: string[] = [];
try {
  redactedTerms = redactionRow?.value ? JSON.parse(redactionRow.value) : [];
} catch {}
const redact = (text: string) => {
  let result = text;
  for (const term of redactedTerms) {
    const trimmed = term.trim();
    if (trimmed) result = result.replaceAll(trimmed, "[REDACTED]");
  }
  return result;
};

const rows = db.query(sql).all(...params) as Array<Record<string, unknown>>;
if (rows.length === 0) {
  console.log("No matching memory found.");
  process.exit(0);
}

console.log(`Found ${rows.length} result(s):\n`);
for (const row of rows) {
  const content = redact(String(row.content ?? ""));
  console.log(`- [${row.role}] ${new Date(Number(row.timestamp ?? Date.now())).toLocaleString()}`);
  console.log(`  session: ${row.session_id ?? "(none)"}`);
  console.log(`  turn: ${row.turn_id ?? "(none)"}`);
  console.log(`  snippet: ${redact(createSnippet(content, query))}`);
  console.log();
}
