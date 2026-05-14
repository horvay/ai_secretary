#!/usr/bin/env bun
/** Print Ari's learned user profile markdown. */

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

const path = join(getDataDir(), "memory", "user_profile.md");
const dbPath = join(getDataDir(), "memory", "memory.db");
if (dbPath) {
  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });
  const row = db.query("SELECT value FROM app_state WHERE key = 'memory.enabled' LIMIT 1").get() as { value?: string } | null;
  const enabled = row?.value ? (() => { try { const parsed = JSON.parse(row.value); return typeof parsed === "boolean" ? parsed : true; } catch { return row.value === "1" || row.value === "true"; } })() : true;
  if (!enabled) {
    console.log("Memory is disabled.");
    process.exit(0);
  }
  const redactRow = db.query("SELECT value FROM app_state WHERE key = 'privacy.redactedTerms' LIMIT 1").get() as { value?: string } | null;
  let content = existsSync(path) ? readFileSync(path, "utf8") : "";
  try {
    const terms = redactRow?.value ? JSON.parse(redactRow.value) as string[] : [];
    for (const term of terms) {
      const trimmed = term.trim();
      if (trimmed) content = content.replaceAll(trimmed, "[REDACTED]");
    }
  } catch {}
  if (!existsSync(path)) {
    console.log(`No user profile found at ${path}`);
    process.exit(1);
  }
  console.log(content);
  process.exit(0);
}

if (!existsSync(path)) {
  console.log(`No user profile found at ${path}`);
  process.exit(1);
}

console.log(readFileSync(path, "utf8"));
