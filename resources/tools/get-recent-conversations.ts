#!/usr/bin/env bun
/** Show recent reconstructed conversation sessions. */

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
const limit = Math.max(1, Math.min(20, Number.parseInt(process.argv[2] ?? "10", 10) || 10));
const rows = db.query(`
  SELECT
    s.id,
    s.pi_session_id,
    s.started_at,
    s.ended_at,
    COUNT(t.id) as turn_count,
    (SELECT content FROM interactions i WHERE i.session_id = s.id ORDER BY i.timestamp ASC LIMIT 1) as preview
  FROM conversation_sessions s
  LEFT JOIN conversation_turns t ON t.session_id = s.id
  GROUP BY s.id
  ORDER BY s.started_at DESC
  LIMIT ?
`).all(limit) as Array<Record<string, unknown>>;
if (rows.length === 0) {
  console.log("No conversation sessions found.");
  process.exit(0);
}
for (const row of rows) {
  console.log(`- ${row.id}`);
  console.log(`  started: ${new Date(Number(row.started_at) * 1000).toLocaleString()}`);
  console.log(`  pi_session: ${row.pi_session_id ?? "(none)"}`);
  console.log(`  turns: ${row.turn_count}`);
  console.log(`  preview: ${redact(String(row.preview ?? "").slice(0, 160))}`);
  console.log();
}
