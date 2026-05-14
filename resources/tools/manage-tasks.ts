#!/usr/bin/env bun
/** Manage Ari's first-class tasks. */

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

function ensureTasks(db: Database) {
  const table = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'")
    .get();
  if (!table) {
    console.log("Error: tasks table not found. Start the AI Secretary app first so it can initialize/migrate the database.");
    process.exit(1);
  }
}

const dbPath = findDbPath();
if (!existsSync(dbPath)) {
  console.log(`Error: Database not found at ${dbPath}`);
  process.exit(1);
}
const db = new Database(dbPath);
ensureTasks(db);

const [command = "list", ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const now = Math.floor(Date.now() / 1000);

switch (command) {
  case "add": {
    const title = args.title ?? args.task;
    if (!title) {
      console.log('Error: --title is required');
      process.exit(1);
    }
    const result = db.query(`INSERT INTO tasks (title, description, status, priority, created_at, updated_at)
      VALUES (?, ?, 'open', ?, ?, ?)`).run(title, args.description ?? null, args.priority ?? "normal", now, now);
    console.log(`Created task [${result.lastInsertRowid}] ${title}`);
    break;
  }
  case "complete": {
    if (!args.id) throw new Error("--id is required");
    db.query("UPDATE tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?").run(now, now, Number(args.id));
    console.log(`Completed task ${args.id}`);
    break;
  }
  case "cancel": {
    if (!args.id) throw new Error("--id is required");
    db.query("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, Number(args.id));
    console.log(`Cancelled task ${args.id}`);
    break;
  }
  case "delete": {
    if (!args.id) throw new Error("--id is required");
    db.query("DELETE FROM tasks WHERE id = ?").run(Number(args.id));
    console.log(`Deleted task ${args.id}`);
    break;
  }
  case "list":
  default: {
    const status = args.status;
    const rows = status
      ? db.query("SELECT * FROM tasks WHERE status = ? ORDER BY COALESCE(due_at, 9999999999), created_at DESC").all(status)
      : db.query("SELECT * FROM tasks ORDER BY COALESCE(due_at, 9999999999), created_at DESC").all();
    if (rows.length === 0) {
      console.log("No tasks found.");
      break;
    }
    for (const row of rows as any[]) {
      console.log(`[${row.id}] ${row.status.toUpperCase()} ${row.title}${row.priority ? ` (${row.priority})` : ""}`);
      if (row.description) console.log(`    ${row.description}`);
    }
  }
}
