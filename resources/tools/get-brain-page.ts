#!/usr/bin/env bun
/** Read a GBrain-style Ari brain page from local AI Secretary state. */

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

const [, , ...rest] = process.argv;
const args = parseArgs(rest);
const slug = (args.slug ?? rest.find((value) => !value.startsWith("--")) ?? "").trim();

if (!slug) {
  console.log("Usage: bun resources/tools/get-brain-page.ts --slug people/user|daily/YYYY-MM-DD|memory/interactions/<id>");
  process.exit(1);
}

const dataDir = findDataDir();
const dbPath = join(dataDir, "memory", "memory.db");
if (!existsSync(dbPath)) {
  console.log(`Error: memory database not found at ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const redactedTerms = readStringArraySetting(db, "privacy.redactedTerms");

if (slug === "people/user") {
  const profilePath = join(dataDir, "memory", "user_profile.md");
  if (!existsSync(profilePath)) {
    console.log("Page not found: people/user");
    process.exit(1);
  }
  const content = redact(readFileSync(profilePath, "utf8"), redactedTerms);
  console.log(`---\ntype: person\ntitle: User Profile\nslug: people/user\n---\n\n${content}`);
  process.exit(0);
}

if (slug.startsWith("daily/")) {
  const date = slug.slice("daily/".length);
  const row = db.query("SELECT date, summary, interaction_count, created_at, updated_at FROM daily_summaries WHERE date = ? LIMIT 1").get(date) as
    | { date: string; summary: string; interaction_count: number; created_at: number; updated_at: number }
    | null;
  if (!row) {
    console.log(`Page not found: ${slug}`);
    process.exit(1);
  }
  console.log(`---\ntype: daily_summary\ntitle: Daily Summary ${row.date}\nslug: ${slug}\ninteraction_count: ${row.interaction_count}\ncreated_at: ${row.created_at}\nupdated_at: ${row.updated_at}\n---\n\n${redact(row.summary, redactedTerms)}`);
  process.exit(0);
}

if (slug.startsWith("memory/interactions/")) {
  const id = Number.parseInt(slug.slice("memory/interactions/".length), 10);
  if (!Number.isInteger(id)) {
    console.log(`Invalid interaction slug: ${slug}`);
    process.exit(1);
  }
  const row = db.query("SELECT * FROM interactions WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | null;
  if (!row) {
    console.log(`Page not found: ${slug}`);
    process.exit(1);
  }
  const content = redact(String(row.content ?? ""), redactedTerms);
  console.log(`---\ntype: interaction\ntitle: ${row.role ?? "unknown"} interaction ${id}\nslug: ${slug}\nrole: ${row.role ?? "unknown"}\nsession_id: ${row.session_id ?? ""}\nturn_id: ${row.turn_id ?? ""}\ntimestamp: ${row.timestamp ?? ""}\n---\n\n${content}`);
  process.exit(0);
}

console.log(`Page not found: ${slug}`);
process.exit(1);
