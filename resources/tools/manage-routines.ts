#!/usr/bin/env bun
/**
 * Manage Ari's Routines/Reminders
 *
 * A CLI tool for managing routines and reminders.
 *
 * Usage:
 *   bun resources/tools/manage-routines.ts list
 *   bun resources/tools/manage-routines.ts add --name "Take vitamins" --schedule daily
 *   bun resources/tools/manage-routines.ts create-agentic --spec '{"name":"Morning focus","goal":"Help me start focused","triggers":[{"type":"schedule","schedule":{"type":"specific_time","time":"09:00"}}]}'
 *   bun resources/tools/manage-routines.ts complete --id 1
 *   bun resources/tools/manage-routines.ts snooze --id 1 --duration "2h"
 *   bun resources/tools/manage-routines.ts delete --id 1
 *   bun resources/tools/manage-routines.ts pending
 *
 * Schedule Types:
 *   - daily: Due if not completed today
 *   - specific_time: Due after a specific time (e.g., "09:00")
 *   - weekly_quota: Due if completed fewer than N times this week (e.g., "3")
 *   - interval: Due N hours/days after last completion (e.g., "4h", "2d")
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

function findMemoryDir(): string {
  return join(getDataDir(), "memory");
}

const DB_PATH = join(findMemoryDir(), "memory.db");

function getDb(): Database {
  if (!existsSync(DB_PATH)) {
    // Use console.log for errors so they appear in tool output (stderr may not be captured)
    console.log(`Error: Database not found at ${DB_PATH}`);
    console.log("The memory database has not been created yet. Start the AI Secretary app first.");
    process.exit(1);
  }
  // Show which database we're using (helpful for debugging sync issues)
  console.log(`[DB: ${DB_PATH}]`);
  const db = new Database(DB_PATH);
  ensureRoutinesTable(db);
  return db;
}

/**
 * Ensure the routines tables exist via the app's central migrations.
 */
function ensureRoutinesTable(db: Database): void {
  const routinesTable = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='routines'")
    .get();
  const completionsTable = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='routine_completions'")
    .get();
  if (!routinesTable || !completionsTable) {
    console.log("Error: routine tables not found. Start the AI Secretary app first so it can initialize/migrate the database.");
    process.exit(1);
  }

  const columns = db.query("PRAGMA table_info(routines)").all() as { name: string }[];
  const names = new Set(columns.map((column) => column.name));
  for (const name of ["goal", "triggers", "conditions", "context_requests", "action_graph", "permissions", "routine_state", "evaluation", "delivery"]) {
    if (!names.has(name)) db.exec(`ALTER TABLE routines ADD COLUMN ${name} TEXT`);
  }
  for (const name of ["last_run_at", "next_run_at"]) {
    if (!names.has(name)) db.exec(`ALTER TABLE routines ADD COLUMN ${name} INTEGER`);
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function getTodayDateString(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getCurrentISOWeek(): string {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - day + 3);
  const weekYear = date.getFullYear();
  const firstThursday = new Date(weekYear, 0, 4);
  const firstThursdayDay = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstThursdayDay + 3);
  const weekNo = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${weekYear}-W${String(weekNo).padStart(2, "0")}`;
}

function getCurrentTime(): string {
  const now = new Date();
  return `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;
}

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

function serializeScheduleConfig(scheduleType: string, scheduleValue: string | null) {
  switch (scheduleType) {
    case "specific_time":
      return JSON.stringify({ type: "specific_time", time: scheduleValue ?? "09:00" });
    case "weekly_quota":
      return JSON.stringify({ type: "weekly_quota", count: Number.parseInt(scheduleValue ?? "1", 10) || 1 });
    case "interval": {
      const match = (scheduleValue ?? "24h").match(/^(\d+)([mhd])$/);
      const every = match ? Number.parseInt(match[1], 10) : 24;
      const unit = match?.[2] === "m" ? "minutes" : match?.[2] === "d" ? "days" : "hours";
      return JSON.stringify({ type: "interval", every, unit });
    }
    default:
      return JSON.stringify({ type: "daily" });
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

interface Routine {
  id: number;
  name: string;
  description: string | null;
  schedule_type: string;
  schedule_value: string | null;
  schedule_config?: string | null;
  timezone?: string | null;
  goal?: string | null;
  triggers?: string | null;
  conditions?: string | null;
  context_requests?: string | null;
  action_graph?: string | null;
  permissions?: string | null;
  routine_state?: string | null;
  evaluation?: string | null;
  delivery?: string | null;
  last_run_at?: number | null;
  next_run_at?: number | null;
  enabled: number;
  snoozed_until: number | null;
  created_at: number;
  updated_at: number;
}

interface Completion {
  id: number;
  routine_id: number;
  completed_at: number;
  period_key: string;
}

// ============================================================================
// Routine Operations
// ============================================================================

function listRoutines(db: Database, showAll: boolean = true): void {
  const routines = db.query("SELECT * FROM routines ORDER BY created_at DESC").all() as Routine[];

  if (routines.length === 0) {
    console.log("No routines found. Use 'add' to create one.");
    return;
  }

  console.log(`\nFound ${routines.length} routine(s):\n`);

  for (const routine of routines) {
    const status = getRoutineStatus(db, routine);
    const enabledStr = routine.enabled ? "✓" : "✗";
    const statusStr = status.isDue ? "⏰ DUE" : status.isCompleted ? "✅ DONE" : status.isSnoozed ? "💤 SNOOZED" : "⏸ DISABLED";

    console.log(`[${routine.id}] ${enabledStr} ${routine.name}`);
    console.log(`    Schedule: ${routine.schedule_type}${routine.schedule_value ? ` (${routine.schedule_value})` : ""}`);
    console.log(`    Status: ${statusStr}`);

    if (routine.description) {
      console.log(`    Description: ${routine.description}`);
    }

    if (routine.goal) {
      console.log(`    Goal: ${routine.goal}`);
    }

    if (routine.triggers) {
      console.log(`    Agentic triggers: ${routine.triggers}`);
    }

    if (status.isSnoozed && routine.snoozed_until) {
      console.log(`    Snoozed until: ${new Date(routine.snoozed_until * 1000).toLocaleString()}`);
    }

    if (routine.schedule_type === "weekly_quota") {
      console.log(`    Progress: ${status.completionsThisWeek}/${routine.schedule_value || 1} this week`);
    } else {
      console.log(`    Completions today: ${status.completionsToday}`);
    }

    console.log();
  }
}

function getRoutineStatus(db: Database, routine: Routine): {
  isCompleted: boolean;
  isSnoozed: boolean;
  isDue: boolean;
  completionsToday: number;
  completionsThisWeek: number;
} {
  const todayCompletions = db
    .query("SELECT COUNT(*) as count FROM routine_completions WHERE routine_id = ? AND period_key = ?")
    .get(routine.id, getTodayDateString()) as { count: number };

  const weekCompletions = db
    .query("SELECT COUNT(*) as count FROM routine_completions WHERE routine_id = ? AND period_key = ?")
    .get(routine.id, getCurrentISOWeek()) as { count: number };

  const isSnoozed = routine.snoozed_until ? routine.snoozed_until > Math.floor(Date.now() / 1000) : false;

  let isCompleted = false;
  if (routine.schedule_type === "weekly_quota") {
    const quota = parseInt(routine.schedule_value || "1", 10);
    isCompleted = weekCompletions.count >= quota;
  } else if (routine.schedule_type === "interval") {
    const lastCompletion = db
      .query("SELECT * FROM routine_completions WHERE routine_id = ? ORDER BY completed_at DESC LIMIT 1")
      .get(routine.id) as Completion | null;

    if (lastCompletion) {
      const interval = parseDuration(routine.schedule_value || "24h");
      isCompleted = Date.now() - lastCompletion.completed_at * 1000 < interval;
    }
  } else {
    isCompleted = todayCompletions.count > 0;
  }

  let isDue = routine.enabled === 1 && !isSnoozed && !isCompleted;

  // For specific_time, check if it's after the scheduled time
  if (isDue && routine.schedule_type === "specific_time" && routine.schedule_value) {
    if (getCurrentTime() < routine.schedule_value) {
      isDue = false;
    }
  }

  return {
    isCompleted,
    isSnoozed,
    isDue,
    completionsToday: todayCompletions.count,
    completionsThisWeek: weekCompletions.count,
  };
}

function createAgenticRoutine(db: Database, args: Record<string, string>): void {
  if (!args.spec) {
    console.log('Error: --spec JSON is required');
    process.exit(1);
  }

  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(args.spec) as Record<string, unknown>;
  } catch (error) {
    console.log(`Error: invalid --spec JSON: ${(error as Error).message}`);
    process.exit(1);
  }

  const name = typeof spec.name === "string" ? spec.name : "";
  const goal = typeof spec.goal === "string" ? spec.goal : "";
  if (!name || !goal) {
    console.log('Error: spec.name and spec.goal are required');
    process.exit(1);
  }

  const triggers = Array.isArray(spec.triggers) ? spec.triggers : [{ type: "manual" }];
  const scheduleTrigger = triggers.find((trigger) => {
    return typeof trigger === "object" && trigger !== null && (trigger as { type?: unknown }).type === "schedule";
  }) as { schedule?: { type?: string; time?: string; count?: number; every?: number; unit?: string } } | undefined;
  const schedule = scheduleTrigger?.schedule ?? { type: "daily" };
  const scheduleType = ["daily", "specific_time", "weekly_quota", "interval"].includes(String(schedule.type)) ? String(schedule.type) : "daily";
  const scheduleValue = scheduleType === "specific_time"
    ? String(schedule.time ?? "09:00")
    : scheduleType === "weekly_quota"
      ? String(schedule.count ?? 1)
      : scheduleType === "interval"
        ? `${Number(schedule.every ?? 24)}${schedule.unit === "minutes" ? "m" : schedule.unit === "days" ? "d" : "h"}`
        : null;
  const now = Math.floor(Date.now() / 1000);

  const result = db.query(
    `INSERT INTO routines (
      name, description, schedule_type, schedule_value, schedule_config, timezone,
      goal, triggers, conditions, context_requests, action_graph, permissions, routine_state, evaluation, delivery,
      enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    name,
    typeof spec.description === "string" ? spec.description : null,
    scheduleType,
    scheduleValue,
    JSON.stringify(schedule),
    typeof spec.timezone === "string" ? spec.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
    goal,
    JSON.stringify(triggers),
    JSON.stringify(Array.isArray(spec.conditions) ? spec.conditions : []),
    JSON.stringify(Array.isArray(spec.contextRequests) ? spec.contextRequests : [{ type: "time" }]),
    JSON.stringify(typeof spec.actionGraph === "object" && spec.actionGraph ? spec.actionGraph : { actions: [{ type: "ask_ari", prompt: goal }] }),
    JSON.stringify(typeof spec.permissions === "object" && spec.permissions ? spec.permissions : { read: ["time", "memory", "tasks"], notify: true, act: [], external: "ask" }),
    JSON.stringify({ createdBy: "manage-routines", feedback: [], runCount: 0 }),
    JSON.stringify(typeof spec.evaluation === "object" && spec.evaluation ? spec.evaluation : { askForFeedback: false, successSignals: [] }),
    JSON.stringify(typeof spec.delivery === "object" && spec.delivery ? spec.delivery : { tts: "always", style: "ari", interruptibility: "normal" }),
    spec.enabled === false ? 0 : 1,
    now,
    now,
  );

  console.log(`✅ Created agentic routine "${name}" with ID ${result.lastInsertRowid}`);
  console.log(`   Goal: ${goal}`);
  console.log(`   Trigger(s): ${JSON.stringify(triggers)}`);
}

function addRoutine(db: Database, args: Record<string, string>): void {
  const name = args.name;
  const description = args.description || null;
  const scheduleType = args.schedule || "daily";
  const scheduleValue = args.value || null;

  if (!name) {
    console.log("Error: --name is required");
    console.log("Usage: bun resources/tools/manage-routines.ts add --name \"Take vitamins\" --schedule daily");
    process.exit(1);
  }

  const validTypes = ["daily", "specific_time", "weekly_quota", "interval"];
  if (!validTypes.includes(scheduleType)) {
    console.log(`Error: Invalid schedule type. Must be one of: ${validTypes.join(", ")}`);
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);

  const result = db
    .query(
      `INSERT INTO routines (name, description, schedule_type, schedule_value, schedule_config, timezone, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .run(
      name,
      description,
      scheduleType,
      scheduleValue,
      serializeScheduleConfig(scheduleType, scheduleValue),
      Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
      now,
      now,
    );

  console.log(`✅ Created routine "${name}" with ID ${result.lastInsertRowid}`);
  console.log(`   Schedule: ${scheduleType}${scheduleValue ? ` (${scheduleValue})` : ""}`);
}

function completeRoutine(db: Database, args: Record<string, string>): void {
  const id = parseInt(args.id, 10);

  if (!id) {
    console.log("Error: --id is required");
    console.log("Usage: bun resources/tools/manage-routines.ts complete --id 1");
    process.exit(1);
  }

  const routine = db.query("SELECT * FROM routines WHERE id = ?").get(id) as Routine | null;

  if (!routine) {
    console.log(`Error: Routine with ID ${id} not found`);
    process.exit(1);
  }

  // Determine period key
  let periodKey = getTodayDateString();
  if (routine.schedule_type === "weekly_quota") {
    periodKey = getCurrentISOWeek();
  }

  const now = Math.floor(Date.now() / 1000);

  // Add completion
  db.query(
    `INSERT INTO routine_completions (routine_id, completed_at, period_key)
     VALUES (?, ?, ?)`
  ).run(id, now, periodKey);

  // Clear snooze
  db.query("UPDATE routines SET snoozed_until = NULL, updated_at = ? WHERE id = ?").run(now, id);

  // Use process.stdout.write for more reliable output capture by tools
  process.stdout.write(`✅ Marked "${routine.name}" as completed!\n`);

  // Show updated status
  const status = getRoutineStatus(db, routine);
  if (routine.schedule_type === "weekly_quota") {
    process.stdout.write(`   Progress: ${status.completionsThisWeek + 1}/${routine.schedule_value || 1} this week\n`);
  }
}

function snoozeRoutine(db: Database, args: Record<string, string>): void {
  const id = parseInt(args.id, 10);
  const duration = args.duration || "1h";

  if (!id) {
    console.log("Error: --id is required");
    console.log("Usage: bun resources/tools/manage-routines.ts snooze --id 1 --duration 2h");
    process.exit(1);
  }

  const routine = db.query("SELECT * FROM routines WHERE id = ?").get(id) as Routine | null;

  if (!routine) {
    console.log(`Error: Routine with ID ${id} not found`);
    process.exit(1);
  }

  let durationMs: number;
  try {
    durationMs = parseDuration(duration);
  } catch (e) {
    console.log(`Error: ${(e as Error).message}`);
    process.exit(1);
  }

  const snoozedUntil = Math.floor((Date.now() + durationMs) / 1000);
  const now = Math.floor(Date.now() / 1000);

  db.query("UPDATE routines SET snoozed_until = ?, updated_at = ? WHERE id = ?").run(snoozedUntil, now, id);

  console.log(`💤 Snoozed "${routine.name}" until ${new Date(snoozedUntil * 1000).toLocaleString()}`);
}

function deleteRoutine(db: Database, args: Record<string, string>): void {
  const id = parseInt(args.id, 10);

  if (!id) {
    console.log("Error: --id is required");
    console.log("Usage: bun resources/tools/manage-routines.ts delete --id 1");
    process.exit(1);
  }

  const routine = db.query("SELECT * FROM routines WHERE id = ?").get(id) as Routine | null;

  if (!routine) {
    console.log(`Error: Routine with ID ${id} not found`);
    process.exit(1);
  }

  db.query("DELETE FROM routines WHERE id = ?").run(id);

  console.log(`🗑️ Deleted routine "${routine.name}"`);
}

function toggleRoutine(db: Database, args: Record<string, string>): void {
  const id = parseInt(args.id, 10);

  if (!id) {
    console.log("Error: --id is required");
    console.log("Usage: bun resources/tools/manage-routines.ts toggle --id 1");
    process.exit(1);
  }

  const routine = db.query("SELECT * FROM routines WHERE id = ?").get(id) as Routine | null;

  if (!routine) {
    console.log(`Error: Routine with ID ${id} not found`);
    process.exit(1);
  }

  const newEnabled = routine.enabled ? 0 : 1;
  const now = Math.floor(Date.now() / 1000);

  db.query("UPDATE routines SET enabled = ?, updated_at = ? WHERE id = ?").run(newEnabled, now, id);

  console.log(`${newEnabled ? "✅ Enabled" : "⏸ Disabled"} routine "${routine.name}"`);
}

function updateRoutine(db: Database, args: Record<string, string>): void {
  const id = parseInt(args.id, 10);

  if (!id) {
    console.log("Error: --id is required");
    console.log("Usage: bun resources/tools/manage-routines.ts update --id 1 --name \"New name\"");
    process.exit(1);
  }

  const routine = db.query("SELECT * FROM routines WHERE id = ?").get(id) as Routine | null;

  if (!routine) {
    console.log(`Error: Routine with ID ${id} not found`);
    process.exit(1);
  }

  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (args.name) {
    updates.push("name = ?");
    values.push(args.name);
  }

  if (args.description !== undefined) {
    updates.push("description = ?");
    values.push(args.description || null);
  }

  const nextScheduleType = args.schedule || routine.schedule_type;
  const nextScheduleValue = args.value !== undefined ? (args.value || null) : routine.schedule_value;

  if (args.schedule) {
    const validTypes = ["daily", "specific_time", "weekly_quota", "interval"];
    if (!validTypes.includes(args.schedule)) {
      console.log(`Error: Invalid schedule type. Must be one of: ${validTypes.join(", ")}`);
      process.exit(1);
    }
    updates.push("schedule_type = ?");
    values.push(args.schedule);
  }

  if (args.schedule !== undefined || args.value !== undefined) {
    updates.push("schedule_value = ?");
    values.push(nextScheduleValue);
    updates.push("schedule_config = ?");
    values.push(serializeScheduleConfig(nextScheduleType, nextScheduleValue));
    updates.push("timezone = ?");
    values.push(Intl.DateTimeFormat().resolvedOptions().timeZone || "local");
  }

  if (updates.length === 0) {
    console.log("Error: No updates specified. Use --name, --description, --schedule, or --value");
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  updates.push("updated_at = ?");
  values.push(now);
  values.push(id);

  db.query(`UPDATE routines SET ${updates.join(", ")} WHERE id = ?`).run(...values);

  console.log(`✏️ Updated routine "${routine.name}"`);
}

function showPending(db: Database): void {
  const routines = db.query("SELECT * FROM routines WHERE enabled = 1 ORDER BY created_at DESC").all() as Routine[];

  const pending = routines.filter((routine) => {
    const status = getRoutineStatus(db, routine);
    return status.isDue;
  });

  if (pending.length === 0) {
    console.log("No pending routines. Great job! 🎉");
    return;
  }

  console.log(`\n⏰ ${pending.length} pending routine(s):\n`);

  for (const routine of pending) {
    console.log(`[${routine.id}] ${routine.name}`);
    if (routine.description) {
      console.log(`    ${routine.description}`);
    }
  }

  console.log();
}

function clearSnooze(db: Database, args: Record<string, string>): void {
  const id = parseInt(args.id, 10);

  if (!id) {
    console.log("Error: --id is required");
    console.log("Usage: bun resources/tools/manage-routines.ts clear-snooze --id 1");
    process.exit(1);
  }

  const routine = db.query("SELECT * FROM routines WHERE id = ?").get(id) as Routine | null;

  if (!routine) {
    console.log(`Error: Routine with ID ${id} not found`);
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  db.query("UPDATE routines SET snoozed_until = NULL, updated_at = ? WHERE id = ?").run(now, id);

  console.log(`⏰ Cleared snooze for "${routine.name}"`);
}

// ============================================================================
// Help & Main
// ============================================================================

function printUsage(): void {
  console.log(`
Manage Ari's Routines/Reminders

Usage:
  bun resources/tools/manage-routines.ts <command> [options]

Commands:
  list                    List all routines with status
  pending                 Show only pending (due) routines
  add                     Create a new routine
  create-agentic          Create a goal-driven routine from a JSON spec
  complete                Mark a routine as completed
  snooze                  Snooze a routine for a duration
  clear-snooze            Clear snooze for a routine
  toggle                  Enable/disable a routine
  update                  Update a routine
  delete                  Delete a routine

Options for 'add':
  --name <name>           Routine name (required)
  --description <desc>    Optional description
  --schedule <type>       Schedule type: daily, specific_time, weekly_quota, interval
  --value <value>         Schedule value (e.g., "09:00", "3", "4h")

Options for 'create-agentic':
  --spec <json>           Full agentic routine spec: goal, triggers, conditions, actionGraph, permissions

Options for 'complete', 'snooze', 'toggle', 'update', 'delete', 'clear-snooze':
  --id <id>               Routine ID (required)

Options for 'snooze':
  --duration <duration>   Duration (e.g., "30m", "2h", "1d"). Default: "1h"

Options for 'update':
  --name <name>           New name
  --description <desc>    New description
  --schedule <type>       New schedule type
  --value <value>         New schedule value

Schedule Types:
  daily           - Due once per day (reminder anytime if not done)
  specific_time   - Due after a specific time (e.g., --value "09:00")
  weekly_quota    - Due if not completed N times this week (e.g., --value "3")
  interval        - Due after N hours/days since last completion (e.g., --value "4h")

Examples:
  # Add a daily vitamin reminder
  bun resources/tools/manage-routines.ts add --name "Take vitamins" --schedule daily

  # Add a workout 3x per week
  bun resources/tools/manage-routines.ts add --name "Workout" --schedule weekly_quota --value "3"

  # Add a morning medication reminder at 9am
  bun resources/tools/manage-routines.ts add --name "Take medication" --schedule specific_time --value "09:00"

  # Add a reminder every 4 hours
  bun resources/tools/manage-routines.ts add --name "Drink water" --schedule interval --value "4h"

  # Mark vitamins as done
  bun resources/tools/manage-routines.ts complete --id 1

  # Snooze for 2 hours
  bun resources/tools/manage-routines.ts snooze --id 1 --duration "2h"

  # Show pending routines
  bun resources/tools/manage-routines.ts pending
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
        listRoutines(db, true);
        break;
      case "pending":
        showPending(db);
        break;
      case "add":
        addRoutine(db, args);
        break;
      case "create-agentic":
        createAgenticRoutine(db, args);
        break;
      case "complete":
        completeRoutine(db, args);
        break;
      case "snooze":
        snoozeRoutine(db, args);
        break;
      case "clear-snooze":
        clearSnooze(db, args);
        break;
      case "toggle":
        toggleRoutine(db, args);
        break;
      case "update":
        updateRoutine(db, args);
        break;
      case "delete":
        deleteRoutine(db, args);
        break;
      default:
        console.log(`Unknown command: ${command}`);
        console.log("Use --help to see available commands.");
        process.exit(1);
    }
  } finally {
    db.close();
  }
}

main();

