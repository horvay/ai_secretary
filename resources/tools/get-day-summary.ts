#!/usr/bin/env bun
/** Read daily summaries without raw SQL. */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
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

const path = join(getDataDir(), "memory", "memory.db");
if (!existsSync(path)) {
  console.log(`No database found at ${path}`);
  process.exit(1);
}
const db = new Database(path, { readonly: true });
const enabledRow = db.query("SELECT value FROM app_state WHERE key = 'memory.enabled' LIMIT 1").get() as { value?: string } | null;
const enabled = enabledRow?.value ? (() => { try { const parsed = JSON.parse(enabledRow.value); return typeof parsed === "boolean" ? parsed : true; } catch { return enabledRow.value === "1" || enabledRow.value === "true"; } })() : true;
if (!enabled) {
  console.log("Memory is disabled.");
  process.exit(0);
}
const redactRow = db.query("SELECT value FROM app_state WHERE key = 'privacy.redactedTerms' LIMIT 1").get() as { value?: string } | null;
const redact = (text: string) => {
  let result = text;
  try {
    const terms = redactRow?.value ? JSON.parse(redactRow.value) as string[] : [];
    for (const term of terms) {
      const trimmed = term.trim();
      if (trimmed) result = result.replaceAll(trimmed, "[REDACTED]");
    }
  } catch {}
  return result;
};
const date = process.argv[2]?.trim();
if (date) {
  const row = db.query("SELECT * FROM daily_summaries WHERE date = ? LIMIT 1").get(date) as Record<string, unknown> | null;
  if (!row) {
    console.log(`No daily summary found for ${date}`);
    process.exit(0);
  }
  console.log(`# Summary for ${row.date}\n\n${redact(String(row.summary ?? ""))}\n\nInteractions: ${row.interaction_count}`);
  process.exit(0);
}
const rows = db.query("SELECT * FROM daily_summaries ORDER BY date DESC LIMIT 14").all() as Array<Record<string, unknown>>;
if (rows.length === 0) {
  console.log("No daily summaries found.");
  process.exit(0);
}
for (const row of rows) {
  const summary = redact(String(row.summary ?? ""));
  console.log(`- ${row.date}: ${summary.slice(0, 180)}${summary.length > 180 ? "..." : ""}`);
}
