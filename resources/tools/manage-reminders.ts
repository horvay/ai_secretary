#!/usr/bin/env bun
/**
 * Manage Ari's One-Time Reminders/Timers
 *
 * A CLI tool for managing one-time reminders and timers.
 *
 * Usage:
 *   bun resources/tools/manage-reminders.ts list
 *   bun resources/tools/manage-reminders.ts add --content "Check the oven" --in "10m"
 *   bun resources/tools/manage-reminders.ts add --content "Call mom" --at "15:30"
 *   bun resources/tools/manage-reminders.ts delete --id 1
 *   bun resources/tools/manage-reminders.ts pending
 */

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

// ============================================================================
// Database Connection
// ============================================================================

/**
 * Find the memory database path
 * Prioritizes the source database for consistency during development
 */
function findDbPath(): string {
  return join(getDataDir(), "memory", "memory.db");
}

const DB_PATH = findDbPath();

function getDb(): Database {
  if (!existsSync(DB_PATH)) {
    console.log(`Error: Database not found at ${DB_PATH}`);
    process.exit(1);
  }
  console.log(`[DB: ${DB_PATH}]`);
  const db = new Database(DB_PATH);
  ensureRemindersTable(db);
  return db;
}

/**
 * Ensure the reminders table exists via the app's central migrations.
 */
function ensureRemindersTable(db: Database): void {
  const table = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='reminders'")
    .get();
  if (!table) {
    console.log("Error: reminders table not found. Start the AI Secretary app first so it can initialize/migrate the database.");
    process.exit(1);
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([mhd])$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}. Use formats like "30m", "2h", "1d"`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: throw new Error(`Unknown duration unit: ${unit}`);
  }
}

function parseArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : "true";
      parsed[key] = value;
      if (value !== "true") i++;
    }
  }
  return parsed;
}

interface Reminder {
  id: number;
  content: string;
  due_at: number;
  status: string;
  created_at: number;
  updated_at: number;
}

// ============================================================================
// Reminder Operations
// ============================================================================

function listReminders(db: Database): void {
  const reminders = db.query("SELECT * FROM reminders ORDER BY due_at ASC").all() as Reminder[];

  if (reminders.length === 0) {
    console.log("No reminders found.");
    return;
  }

  console.log(`\nFound ${reminders.length} reminder(s):\n`);

  for (const r of reminders) {
    const statusStr = r.status === 'pending'
      ? '⏳ PENDING'
      : r.status === 'triggered'
        ? '🔔 TRIGGERED'
        : r.status === 'completed'
          ? '✅ COMPLETED'
          : r.status === 'failed'
            ? '⚠️ FAILED'
            : '❌ CANCELLED';
    const dueStr = new Date(r.due_at * 1000).toLocaleString();
    console.log(`[${r.id}] ${r.content}`);
    console.log(`    Due: ${dueStr}`);
    console.log(`    Status: ${statusStr}`);
    console.log();
  }
}

function addReminder(db: Database, args: Record<string, string>): void {
  const content = args.content;
  const inDuration = args.in;
  const atTime = args.at;

  if (!content) {
    console.log("Error: --content is required");
    process.exit(1);
  }

  let dueAt: number;

  if (inDuration) {
    const durationMs = parseDuration(inDuration);
    dueAt = Math.floor((Date.now() + durationMs) / 1000);
  } else if (atTime) {
    // Parse HH:MM
    const [hours, minutes] = atTime.split(":").map(Number);
    const now = new Date();
    const target = new Date();
    target.setHours(hours, minutes, 0, 0);

    // If time is in the past, assume tomorrow
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    dueAt = Math.floor(target.getTime() / 1000);
  } else {
    console.log("Error: Either --in (duration) or --at (HH:MM) is required");
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  const result = db.query(
    "INSERT INTO reminders (content, due_at, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)"
  ).run(content, dueAt, now, now);

  console.log(`✅ Created reminder "${content}" with ID ${result.lastInsertRowid}`);
  console.log(`   Due at: ${new Date(dueAt * 1000).toLocaleString()}`);
}

function deleteReminder(db: Database, args: Record<string, string>): void {
  const id = parseInt(args.id, 10);
  if (!id) {
    console.log("Error: --id is required");
    process.exit(1);
  }

  const result = db.query("DELETE FROM reminders WHERE id = ?").run(id);
  if (result.changes > 0) {
    console.log(`🗑️ Deleted reminder ID ${id}`);
  } else {
    console.log(`ℹ️ Reminder ID ${id} not found`);
  }
}

function showPending(db: Database): void {
  const now = Math.floor(Date.now() / 1000);
  const reminders = db.query("SELECT * FROM reminders WHERE status = 'pending' ORDER BY due_at ASC").all() as Reminder[];

  if (reminders.length === 0) {
    console.log("No pending reminders.");
    return;
  }

  console.log(`\n⏳ ${reminders.length} pending reminder(s):\n`);
  for (const r of reminders) {
    const dueStr = new Date(r.due_at * 1000).toLocaleString();
    console.log(`[${r.id}] ${r.content} (Due: ${dueStr})`);
  }
  console.log();
}

// ============================================================================
// Help & Main
// ============================================================================

function printUsage(): void {
  console.log(`
Manage Ari's One-Time Reminders/Timers

Usage:
  bun resources/tools/manage-reminders.ts <command> [options]

Commands:
  list                    List all reminders
  pending                 Show only pending reminders
  add                     Create a new one-time reminder
  delete                  Delete a reminder

Options for 'add':
  --content <text>        What to remind about (required)
  --in <duration>         In how long (e.g., "10m", "2h", "1d")
  --at <time>             At specific time (e.g., "15:30")

Options for 'delete':
  --id <id>               Reminder ID (required)

Examples:
  # Remind in 5 minutes (timer)
  bun resources/tools/manage-reminders.ts add --content "Pizza is done" --in "5m"

  # Remind at 3pm
  bun resources/tools/manage-reminders.ts add --content "Meeting with boss" --at "15:00"
`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    process.exit(command ? 0 : 1);
  }

  const db = getDb();

  try {
    switch (command) {
      case "list":
        listReminders(db);
        break;
      case "pending":
        showPending(db);
        break;
      case "add":
        addReminder(db, args);
        break;
      case "delete":
        deleteReminder(db, args);
        break;
      default:
        console.log(`Unknown command: ${command}`);
        process.exit(1);
    }
  } finally {
    db.close();
  }
}

main();
