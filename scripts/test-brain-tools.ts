#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";

function getDataDir() {
  const override = process.env.AI_SECRETARY_DATA_DIR?.trim();
  if (override) return override;
  if (process.platform === "win32" && process.env.LOCALAPPDATA?.trim()) return join(process.env.LOCALAPPDATA, ".ai-secretary");
  return join(homedir(), ".ai-secretary");
}

const db = new Database(join(getDataDir(), "memory", "memory.db"));

async function run(name: string, args: string[]) {
  console.log(`\n=== ${name} ===`);
  console.log(`$ ${args.join(" ")}`);
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());
  console.log(`exitCode=${exitCode}`);
  return exitCode;
}

function getState(key: string) {
  return (db.query("SELECT value FROM app_state WHERE key = ? LIMIT 1").get(key) as { value?: string } | null)?.value ?? null;
}

function setState(key: string, value: unknown) {
  const serialized = JSON.stringify(value);
  db.query(
    `INSERT INTO app_state (key, value, value_type, updated_at)
     VALUES (?, ?, 'json', strftime('%s','now'))
     ON CONFLICT(key) DO UPDATE SET value = ?, value_type = 'json', updated_at = strftime('%s','now')`,
  ).run(key, serialized, serialized);
}

const originalMemoryEnabled = getState("memory.enabled");
const originalRedactedTerms = getState("privacy.redactedTerms");

try {
  await run("search profile json", ["bun", "resources/tools/search-brain.ts", "--query", "Communication style", "--limit", "2", "--json"]);
  await run("get profile page", ["bun", "resources/tools/get-brain-page.ts", "--slug", "people/user"]);
  await run("punctuation query should not crash", ["bun", "resources/tools/search-brain.ts", "--query", "hello/world", "--limit", "2"]);
  await run("empty search usage", ["bun", "resources/tools/search-brain.ts", "--query", ""]);
  await run("missing page", ["bun", "resources/tools/get-brain-page.ts", "--slug", "nope/missing"]);

  setState("memory.enabled", false);
  await run("memory disabled", ["bun", "resources/tools/search-brain.ts", "--query", "hello", "--limit", "1"]);

  setState("memory.enabled", true);
  setState("privacy.redactedTerms", ["hello"]);
  await run("redaction", ["bun", "resources/tools/search-brain.ts", "--query", "hello", "--limit", "1"]);
} finally {
  if (originalMemoryEnabled === null) {
    db.query("DELETE FROM app_state WHERE key = 'memory.enabled'").run();
  } else {
    db.query("UPDATE app_state SET value = ?, value_type = 'json', updated_at = strftime('%s','now') WHERE key = 'memory.enabled'").run(originalMemoryEnabled);
  }

  if (originalRedactedTerms === null) {
    db.query("DELETE FROM app_state WHERE key = 'privacy.redactedTerms'").run();
  } else {
    db.query("UPDATE app_state SET value = ?, value_type = 'json', updated_at = strftime('%s','now') WHERE key = 'privacy.redactedTerms'").run(originalRedactedTerms);
  }

  console.log("\nRestored memory settings.");
}
