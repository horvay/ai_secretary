#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(dataDir: string, name: string, args: string[], expectedExit = 0) {
  console.log(`\n=== ${name} ===`);
  console.log(`$ AI_SECRETARY_DATA_DIR=${dataDir} ${args.join(" ")}`);
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AI_SECRETARY_DATA_DIR: dataDir },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());
  console.log(`exitCode=${exitCode}`);
  assert(exitCode === expectedExit, `${name}: expected exit ${expectedExit}, got ${exitCode}`);
  return { stdout, stderr, exitCode };
}

async function createFixtureDataDir() {
  const dataDir = await mkdtemp(join(tmpdir(), "ari-brain-tools-"));
  const memoryDir = join(dataDir, "memory");
  await mkdir(memoryDir, { recursive: true });

  await writeFile(
    join(memoryDir, "user_profile.md"),
    `# User Profile\n\n## Preferences\n- Communication style: concise and direct.\n- Favorite codename: nebula-secret.\n`,
  );

  const db = new Database(join(memoryDir, "memory.db"));
  db.exec(`
    CREATE TABLE app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      value_type TEXT NOT NULL DEFAULT 'json',
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      session_id TEXT,
      turn_id TEXT,
      sequence INTEGER,
      kind TEXT DEFAULT 'message',
      modality TEXT,
      source TEXT,
      timestamp INTEGER NOT NULL,
      date INTEGER NOT NULL,
      metadata TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE VIRTUAL TABLE interactions_fts USING fts5(content, content='interactions', content_rowid='id');
    CREATE TRIGGER interactions_ai AFTER INSERT ON interactions BEGIN
      INSERT INTO interactions_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TABLE daily_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      summary TEXT NOT NULL,
      interaction_count INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE VIRTUAL TABLE daily_summaries_fts USING fts5(summary, content='daily_summaries', content_rowid='id');
    CREATE TRIGGER daily_summaries_ai AFTER INSERT ON daily_summaries BEGIN
      INSERT INTO daily_summaries_fts(rowid, summary) VALUES (new.id, new.summary);
    END;
  `);

  const setState = db.query("INSERT INTO app_state (key, value, value_type) VALUES (?, ?, 'json')");
  setState.run("memory.enabled", JSON.stringify(true));
  setState.run("privacy.redactedTerms", JSON.stringify([]));

  db.query(`
    INSERT INTO interactions (type, role, content, session_id, turn_id, sequence, kind, modality, source, timestamp, date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "text",
    "user",
    "Remember the project codename aurora-pepper and the launch window next Tuesday.",
    "session-fixture",
    "turn-fixture",
    1,
    "message",
    "text",
    "text",
    1_700_000_000_000,
    20260507,
  );

  db.query("INSERT INTO daily_summaries (date, summary, interaction_count) VALUES (?, ?, ?)").run(
    "2026-05-07",
    "Discussed aurora-pepper launch planning and decided to keep responses concise.",
    3,
  );

  db.close();
  return dataDir;
}

const dataDir = await createFixtureDataDir();
try {
  const profileSearch = await run(dataDir, "profile json search", [
    "bun",
    "resources/tools/search-brain.ts",
    "--query",
    "Communication style",
    "--limit",
    "5",
    "--json",
  ]);
  const profileResults = JSON.parse(profileSearch.stdout) as Array<{ slug: string; chunk_text: string }>;
  assert(profileResults.some((result) => result.slug === "people/user"), "profile search should include people/user");

  const interactionSearch = await run(dataDir, "interaction search", [
    "bun",
    "resources/tools/search-brain.ts",
    "--query",
    "aurora-pepper",
    "--limit",
    "5",
    "--json",
  ]);
  const interactionResults = JSON.parse(interactionSearch.stdout) as Array<{ slug: string; type: string }>;
  assert(interactionResults.some((result) => result.slug.startsWith("memory/interactions/")), "interaction search should include memory/interactions slug");

  const dailySearch = await run(dataDir, "daily summary search", [
    "bun",
    "resources/tools/search-brain.ts",
    "--query",
    "launch planning",
    "--limit",
    "5",
    "--json",
  ]);
  const dailyResults = JSON.parse(dailySearch.stdout) as Array<{ slug: string; type: string }>;
  assert(dailyResults.some((result) => result.slug === "daily/2026-05-07"), "daily search should include daily summary slug");

  const profilePage = await run(dataDir, "get profile page", ["bun", "resources/tools/get-brain-page.ts", "--slug", "people/user"]);
  assert(profilePage.stdout.includes("Communication style: concise and direct"), "profile page should include fixture profile content");

  const dailyPage = await run(dataDir, "get daily page", ["bun", "resources/tools/get-brain-page.ts", "--slug", "daily/2026-05-07"]);
  assert(dailyPage.stdout.includes("aurora-pepper launch planning"), "daily page should include fixture summary");

  const interactionSlug = interactionResults.find((result) => result.slug.startsWith("memory/interactions/"))?.slug;
  assert(interactionSlug, "expected interaction slug");
  const interactionPage = await run(dataDir, "get interaction page", ["bun", "resources/tools/get-brain-page.ts", "--slug", interactionSlug]);
  assert(interactionPage.stdout.includes("project codename aurora-pepper"), "interaction page should include fixture interaction");

  await run(dataDir, "punctuation query", ["bun", "resources/tools/search-brain.ts", "--query", "aurora/pepper", "--limit", "2"]);
  await run(dataDir, "missing page", ["bun", "resources/tools/get-brain-page.ts", "--slug", "missing/page"], 1);
  await run(dataDir, "empty query", ["bun", "resources/tools/search-brain.ts", "--query", ""], 1);

  const db = new Database(join(dataDir, "memory", "memory.db"));
  db.query("UPDATE app_state SET value = ? WHERE key = 'privacy.redactedTerms'").run(JSON.stringify(["aurora-pepper"]));
  db.close();
  const redacted = await run(dataDir, "redaction", ["bun", "resources/tools/search-brain.ts", "--query", "aurora-pepper", "--limit", "2"]);
  assert(redacted.stdout.includes("[REDACTED]"), "redacted output should contain [REDACTED]");
  assert(!redacted.stdout.includes("project codename aurora-pepper"), "redacted snippet should not expose exact secret phrase");

  const db2 = new Database(join(dataDir, "memory", "memory.db"));
  db2.query("UPDATE app_state SET value = ? WHERE key = 'memory.enabled'").run(JSON.stringify(false));
  db2.close();
  const disabled = await run(dataDir, "memory disabled", ["bun", "resources/tools/search-brain.ts", "--query", "aurora-pepper"]);
  assert(disabled.stdout.includes("Memory is disabled."), "disabled memory should be respected");

  console.log("\nAll isolated brain tool assertions passed.");
} finally {
  await rm(dataDir, { recursive: true, force: true });
  console.log(`Cleaned up ${dataDir}`);
}
