#!/usr/bin/env bun
/** Search local microphone and speaker transcripts. */

import { Database } from "bun:sqlite";
import { join } from "path";
import { existsSync } from "fs";
import { homedir } from "os";

function getDataDir() {
  const override = process.env.AI_SECRETARY_DATA_DIR?.trim();
  if (override) return override;
  if (process.platform === "win32" && process.env.LOCALAPPDATA?.trim()) return join(process.env.LOCALAPPDATA, ".ai-secretary");
  return join(homedir(), ".ai-secretary");
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

function sanitizeFtsQuery(query: string) {
  const tokens = query
    .slice(0, 240)
    .match(/[\p{L}\p{N}_'-]+/gu)
    ?.map((token) => token.replace(/"/g, "").trim())
    .filter(Boolean)
    .slice(0, 12) ?? [];
  return tokens.map((token) => `"${token}"`).join(" ");
}

const dbPath = join(getDataDir(), "memory", "memory.db");
if (!existsSync(dbPath)) {
  console.log(`Error: Database not found at ${dbPath}`);
  process.exit(1);
}

const [, , ...rest] = process.argv;
const args = parseArgs(rest);
const query = (args.query ?? args.q ?? rest.find((value) => !value.startsWith("--")) ?? "").trim();
const source = args.source === "microphone" || args.source === "speaker" ? args.source : "all";
const minutes = args.minutes ? Math.max(1, Math.min(1440, Number.parseInt(args.minutes, 10) || 5)) : null;
const limit = Math.max(1, Math.min(50, Number.parseInt(args.limit ?? "10", 10) || 10));

const db = new Database(dbPath, { readonly: true });
const values: unknown[] = [];
const filters: string[] = [];
if (source !== "all") {
  filters.push("a.source = ?");
  values.push(source);
}
if (minutes !== null) {
  filters.push("a.timestamp >= ?");
  values.push(Date.now() - minutes * 60 * 1000);
}

let rows: Array<Record<string, unknown>> = [];
if (query) {
  const fts = sanitizeFtsQuery(query);
  if (fts) {
    try {
      const ftsValues = [...values, fts, limit];
      rows = db.query(`
        SELECT a.* FROM audio_transcripts a
        JOIN audio_transcripts_fts ON audio_transcripts_fts.rowid = a.id
        ${filters.length ? `WHERE ${filters.join(" AND ")} AND` : "WHERE"} audio_transcripts_fts MATCH ?
        ORDER BY bm25(audio_transcripts_fts), a.timestamp DESC
        LIMIT ?
      `).all(...ftsValues) as Array<Record<string, unknown>>;
    } catch {
      rows = [];
    }
  }
  if (rows.length === 0) {
    rows = db.query(`
      SELECT a.* FROM audio_transcripts a
      ${filters.length ? `WHERE ${filters.join(" AND ")} AND` : "WHERE"} a.content LIKE ?
      ORDER BY a.timestamp DESC
      LIMIT ?
    `).all(...values, `%${query.slice(0, 240)}%`, limit) as Array<Record<string, unknown>>;
  }
} else {
  rows = db.query(`
    SELECT a.* FROM audio_transcripts a
    ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
    ORDER BY a.timestamp DESC
    LIMIT ?
  `).all(...values, limit) as Array<Record<string, unknown>>;
}

if (rows.length === 0) {
  console.log("No matching audio transcripts found.");
  process.exit(0);
}

console.log(`Found ${rows.length} audio transcript result(s):\n`);
for (const row of rows) {
  const when = new Date(Number(row.timestamp ?? Date.now())).toLocaleString();
  const label = String(row.source ?? "unknown").toUpperCase();
  const windowTitle = row.window_title ? ` · ${row.window_title}` : "";
  console.log(`- [${label}] ${when}${windowTitle}`);
  console.log(`  ${String(row.content ?? "").trim()}`);
  console.log();
}
