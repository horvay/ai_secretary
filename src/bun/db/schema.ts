/**
 * SQLite Database Schema for Ari's Memory System
 * Uses Bun's built-in SQLite support
 */

import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdir, copyFile } from "fs/promises";
import { existsSync } from "fs";
import { logInfo, logError, logDebug, logWarn } from "../utils/logger";
import { getUserMemoryDir } from "../utils/paths";

// Database path - use the new mutable user-data memory directory only.
// Intentionally no fallback to the old runtime/memory layout.
const MEMORY_DIR = getUserMemoryDir();
const DB_PATH = join(MEMORY_DIR, "memory.db");

// Singleton database instance
let db: Database | null = null;

/**
 * Interaction types
 * - voice: Transcribed voice input directed at Ari
 * - text: Text input from the user
 * - screenshot: Screenshot-related interaction
 * - context: Background speech/context not directed at Ari (overheard)
 */
export type InteractionType = "voice" | "text" | "screenshot" | "context";

/**
 * Interaction record
 */
export type InteractionRole = "user" | "assistant" | "system" | "tool";
export type InteractionKind = "message" | "screenshot" | "ocr" | "context" | "tool_call" | "tool_result" | "summary";
export type InteractionModality = "text" | "voice" | "image" | "audio";

export interface Interaction {
  id: number;
  type: InteractionType;
  role: InteractionRole;
  content: string;
  session_id: string | null;
  turn_id?: string | null;
  sequence?: number | null;
  kind?: InteractionKind | null;
  modality?: InteractionModality | null;
  source?: string | null;
  timestamp: number;
  date: number; // YYYYMMDD format as integer (e.g., 20260106)
  metadata: string | null; // JSON string for extra data
}

export interface ConversationSession {
  id: string;
  pi_session_id: string | null;
  title: string | null;
  started_at: number;
  ended_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ConversationTurn {
  id: string;
  session_id: string;
  started_at: number;
  completed_at: number | null;
  status: "running" | "completed" | "interrupted" | "error";
  source: "text" | "voice" | "routine" | "reminder" | "system";
}

/**
 * Daily summary record
 */
export interface DailySummary {
  id: number;
  date: string; // YYYY-MM-DD format
  summary: string;
  interaction_count: number;
  created_at: number;
  updated_at: number;
}

/**
 * Screenshot record
 */
export interface Screenshot {
  id: number;
  file_key: string; // e.g., screenshot_image_1704470400-a1b2c3.png
  ocr_text: string | null;
  session_id?: string | null;
  turn_id?: string | null;
  timestamp: number;
  width: number | null;
  height: number | null;
  metadata: string | null; // JSON string for extra data
}

/**
 * Schedule types for routines
 */
export type ScheduleType = "daily" | "specific_time" | "weekly_quota" | "interval";

/**
 * Routine record
 */
export interface Routine {
  id: number;
  name: string;
  description: string | null;
  schedule_type: ScheduleType;
  schedule_value: string | null; // legacy display/compat field, e.g. "09:00", "3", "4h"
  schedule_config?: string | null; // JSON schedule config
  timezone?: string | null;
  goal?: string | null;
  triggers?: string | null; // JSON Trigger[]
  conditions?: string | null; // JSON Guard[]
  context_requests?: string | null; // JSON ContextRequest[]
  action_graph?: string | null; // JSON ActionGraph
  permissions?: string | null; // JSON PermissionPolicy
  routine_state?: string | null; // JSON durable routine-local state
  evaluation?: string | null; // JSON EvaluationPolicy
  delivery?: string | null; // JSON delivery/style preferences
  last_run_at?: number | null;
  next_run_at?: number | null;
  enabled: number; // 1 = active, 0 = disabled
  snoozed_until: number | null; // Unix timestamp if snoozed
  created_at: number;
  updated_at: number;
}

/**
 * Routine completion record
 */
export interface RoutineCompletion {
  id: number;
  routine_id: number;
  completed_at: number; // Unix timestamp
  period_key: string; // "2026-01-07" for daily, "2026-W02" for weekly
}

/**
 * App state key-value store
 */
export interface AppState {
  key: string;
  value: string;
  value_type?: string;
  updated_at: number;
}

/**
 * List record - a named collection of items
 */
export interface List {
  id: number;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * List item record - an item in a list
 */
export interface ListItem {
  id: number;
  list_id: number;
  content: string;
  position: number;
  created_at: number;
}

/**
 * Reminder record - a one-time alert
 */
export type ReminderStatus = "pending" | "triggered" | "completed" | "cancelled" | "failed";

export interface Reminder {
  id: number;
  content: string;
  due_at: number; // Unix timestamp
  status: ReminderStatus;
  triggered_at?: number | null;
  delivered_at?: number | null;
  acknowledged_at?: number | null;
  last_error?: string | null;
  trigger_count?: number;
  created_at: number;
  updated_at: number;
}

export interface Task {
  id: number;
  title: string;
  description: string | null;
  status: "open" | "completed" | "cancelled";
  priority: "low" | "normal" | "high" | null;
  due_at: number | null;
  reminder_at: number | null;
  list_id: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  metadata: string | null;
}

/**
 * Schema creation SQL statements
 */
const SCHEMA_SQL = `
-- Interactions table: logs all user/assistant interactions
CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('voice', 'text', 'screenshot', 'context')),
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL,
  session_id TEXT,
  turn_id TEXT,
  sequence INTEGER,
  kind TEXT DEFAULT 'message',
  modality TEXT,
  source TEXT,
  timestamp INTEGER NOT NULL,
  date INTEGER NOT NULL DEFAULT (CAST(strftime('%Y%m%d', 'now', 'localtime') AS INTEGER)),
  metadata TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Index for faster timestamp-based queries
CREATE INDEX IF NOT EXISTS idx_interactions_timestamp ON interactions(timestamp);
CREATE INDEX IF NOT EXISTS idx_interactions_type ON interactions(type);
CREATE INDEX IF NOT EXISTS idx_interactions_session ON interactions(session_id);
CREATE INDEX IF NOT EXISTS idx_interactions_turn_id ON interactions(turn_id);
CREATE INDEX IF NOT EXISTS idx_interactions_session_timestamp ON interactions(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_interactions_date ON interactions(date);

-- Conversation sessions/turns: app-level reconstruction independent of pi internals
CREATE TABLE IF NOT EXISTS conversation_sessions (
  id TEXT PRIMARY KEY,
  pi_session_id TEXT,
  title TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'interrupted', 'error')),
  source TEXT NOT NULL CHECK(source IN ('text', 'voice', 'routine', 'reminder', 'system')),
  FOREIGN KEY(session_id) REFERENCES conversation_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_turns_session_id ON conversation_turns(session_id);

-- Daily summaries table: one summary per day
CREATE TABLE IF NOT EXISTS daily_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL,
  interaction_count INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Index for date lookups
CREATE INDEX IF NOT EXISTS idx_daily_summaries_date ON daily_summaries(date);

-- Screenshots table: OCR text and metadata for screenshots
CREATE TABLE IF NOT EXISTS screenshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_key TEXT NOT NULL UNIQUE,
  ocr_text TEXT,
  session_id TEXT,
  turn_id TEXT,
  timestamp INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  metadata TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Index for file key lookups
CREATE INDEX IF NOT EXISTS idx_screenshots_file_key ON screenshots(file_key);
CREATE INDEX IF NOT EXISTS idx_screenshots_turn_id ON screenshots(turn_id);
CREATE INDEX IF NOT EXISTS idx_screenshots_timestamp ON screenshots(timestamp);

-- Audio transcripts: local searchable mic/speaker transcript log
CREATE TABLE IF NOT EXISTS audio_transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK(source IN ('microphone', 'speaker')),
  content TEXT NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  timestamp INTEGER NOT NULL,
  date INTEGER NOT NULL,
  app_name TEXT,
  window_title TEXT,
  session_id TEXT,
  turn_id TEXT,
  routed_to_ai INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  sample_rate INTEGER,
  model TEXT,
  language TEXT,
  confidence REAL,
  capture_backend TEXT,
  device_name TEXT,
  metadata TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_audio_transcripts_timestamp ON audio_transcripts(timestamp);
CREATE INDEX IF NOT EXISTS idx_audio_transcripts_source ON audio_transcripts(source);
CREATE INDEX IF NOT EXISTS idx_audio_transcripts_date ON audio_transcripts(date);
CREATE INDEX IF NOT EXISTS idx_audio_transcripts_source_timestamp ON audio_transcripts(source, timestamp);

CREATE VIRTUAL TABLE IF NOT EXISTS audio_transcripts_fts USING fts5(
  content,
  content='audio_transcripts',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS audio_transcripts_ai AFTER INSERT ON audio_transcripts BEGIN
  INSERT INTO audio_transcripts_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS audio_transcripts_ad AFTER DELETE ON audio_transcripts BEGIN
  INSERT INTO audio_transcripts_fts(audio_transcripts_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS audio_transcripts_au AFTER UPDATE ON audio_transcripts BEGIN
  INSERT INTO audio_transcripts_fts(audio_transcripts_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO audio_transcripts_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE VIEW IF NOT EXISTS audio_transcripts_readable AS
SELECT
  id,
  source,
  content,
  started_at,
  ended_at,
  timestamp,
  date,
  substr(date, 1, 4) || '-' || substr(date, 5, 2) || '-' || substr(date, 7, 2) AS date_formatted,
  datetime(timestamp / 1000, 'unixepoch', 'localtime') AS datetime_formatted,
  time(timestamp / 1000, 'unixepoch', 'localtime') AS time_formatted,
  app_name,
  window_title,
  session_id,
  turn_id,
  routed_to_ai,
  duration_ms,
  sample_rate,
  model,
  language,
  confidence,
  capture_backend,
  device_name,
  metadata
FROM audio_transcripts;

-- Full-text search virtual table for interactions
CREATE VIRTUAL TABLE IF NOT EXISTS interactions_fts USING fts5(
  content,
  content='interactions',
  content_rowid='id'
);

-- Triggers to keep FTS in sync with interactions table
CREATE TRIGGER IF NOT EXISTS interactions_ai AFTER INSERT ON interactions BEGIN
  INSERT INTO interactions_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS interactions_ad AFTER DELETE ON interactions BEGIN
  INSERT INTO interactions_fts(interactions_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS interactions_au AFTER UPDATE ON interactions BEGIN
  INSERT INTO interactions_fts(interactions_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO interactions_fts(rowid, content) VALUES (new.id, new.content);
END;

-- View for human-readable interactions with time gaps
-- Usage: SELECT * FROM interactions_readable WHERE date = 20260106
CREATE VIEW IF NOT EXISTS interactions_readable AS
SELECT
  id,
  type,
  role,
  content,
  session_id,
  timestamp,
  date,
  -- Format date as YYYY-MM-DD
  substr(date, 1, 4) || '-' || substr(date, 5, 2) || '-' || substr(date, 7, 2) AS date_formatted,
  -- Format timestamp as readable datetime (local time)
  datetime(timestamp / 1000, 'unixepoch', 'localtime') AS datetime_formatted,
  -- Time of day only
  time(timestamp / 1000, 'unixepoch', 'localtime') AS time_formatted,
  -- Minutes since previous interaction (for detecting gaps)
  ROUND((timestamp - LAG(timestamp) OVER (ORDER BY timestamp)) / 60000.0, 1) AS minutes_since_prev,
  turn_id,
  sequence,
  kind,
  modality,
  source,
  metadata
FROM interactions;

-- View for daily summaries with readable date
CREATE VIEW IF NOT EXISTS daily_summaries_readable AS
SELECT
  id,
  date,
  substr(date, 1, 4) || '-' || substr(date, 5, 2) || '-' || substr(date, 7, 2) AS date_formatted,
  summary,
  interaction_count,
  datetime(created_at, 'unixepoch', 'localtime') AS created_at_formatted,
  datetime(updated_at, 'unixepoch', 'localtime') AS updated_at_formatted
FROM daily_summaries;

-- Routines table: stores user routines/reminders
CREATE TABLE IF NOT EXISTS routines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  schedule_type TEXT NOT NULL CHECK(schedule_type IN ('daily', 'specific_time', 'weekly_quota', 'interval')),
  schedule_value TEXT,
  schedule_config TEXT,
  timezone TEXT NOT NULL DEFAULT 'local',
  goal TEXT,
  triggers TEXT,
  conditions TEXT,
  context_requests TEXT,
  action_graph TEXT,
  permissions TEXT,
  routine_state TEXT,
  evaluation TEXT,
  delivery TEXT,
  last_run_at INTEGER,
  next_run_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  snoozed_until INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Index for routine queries
CREATE INDEX IF NOT EXISTS idx_routines_enabled ON routines(enabled);

-- Routine completions table: tracks when routines are completed
CREATE TABLE IF NOT EXISTS routine_completions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_id INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  period_key TEXT NOT NULL,
  FOREIGN KEY (routine_id) REFERENCES routines(id) ON DELETE CASCADE
);

-- Indexes for completion queries
CREATE INDEX IF NOT EXISTS idx_routine_completions_routine_id ON routine_completions(routine_id);
CREATE INDEX IF NOT EXISTS idx_routine_completions_period_key ON routine_completions(period_key);

-- App state table: key-value store for app settings like last_voice_activity
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'json',
  updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- View for routines with completion status
CREATE VIEW IF NOT EXISTS routines_with_status AS
SELECT
  r.id,
  r.name,
  r.description,
  r.schedule_type,
  r.schedule_value,
  r.schedule_config,
  r.timezone,
  r.enabled,
  r.snoozed_until,
  r.goal,
  r.triggers,
  r.conditions,
  r.context_requests,
  r.action_graph,
  r.permissions,
  r.routine_state,
  r.evaluation,
  r.delivery,
  r.last_run_at,
  r.next_run_at,
  r.created_at,
  r.updated_at,
  datetime(r.created_at, 'unixepoch', 'localtime') AS created_at_formatted,
  datetime(r.updated_at, 'unixepoch', 'localtime') AS updated_at_formatted,
  CASE WHEN r.snoozed_until > strftime('%s', 'now') THEN 1 ELSE 0 END AS is_snoozed,
  (SELECT COUNT(*) FROM routine_completions rc
   WHERE rc.routine_id = r.id
   AND rc.period_key = date('now', 'localtime')) AS completions_today,
  (SELECT COUNT(*) FROM routine_completions rc
   WHERE rc.routine_id = r.id
   AND rc.period_key LIKE strftime('%Y-W%W', 'now', 'localtime')) AS completions_this_week
FROM routines r;

-- Lists table: named collections of items
CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Index for list name lookups
CREATE INDEX IF NOT EXISTS idx_lists_name ON lists(name);

-- List items table: items belonging to lists
CREATE TABLE IF NOT EXISTS list_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  position INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE
);

-- Indexes for list item queries
CREATE INDEX IF NOT EXISTS idx_list_items_list_id ON list_items(list_id);
CREATE INDEX IF NOT EXISTS idx_list_items_position ON list_items(position);

-- View for lists with item counts
CREATE VIEW IF NOT EXISTS lists_with_counts AS
SELECT
  l.id,
  l.name,
  l.description,
  l.created_at,
  l.updated_at,
  datetime(l.created_at, 'unixepoch', 'localtime') AS created_at_formatted,
  datetime(l.updated_at, 'unixepoch', 'localtime') AS updated_at_formatted,
  (SELECT COUNT(*) FROM list_items li WHERE li.list_id = l.id) AS item_count
FROM lists l;

-- Reminders table: one-time alerts
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'triggered', 'completed', 'cancelled', 'failed')),
  triggered_at INTEGER,
  delivered_at INTEGER,
  acknowledged_at INTEGER,
  last_error TEXT,
  trigger_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Tasks table: first-class user action items
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'completed', 'cancelled')),
  priority TEXT DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high')),
  due_at INTEGER,
  reminder_at INTEGER,
  list_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  metadata TEXT,
  FOREIGN KEY(list_id) REFERENCES lists(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_at ON tasks(due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_list_id ON tasks(list_id);

-- Routine trigger table: idempotent reminder/routine notifications
CREATE TABLE IF NOT EXISTS routine_triggers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_id INTEGER NOT NULL,
  triggered_at INTEGER NOT NULL,
  period_key TEXT,
  status TEXT NOT NULL,
  FOREIGN KEY(routine_id) REFERENCES routines(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_routine_triggers_routine_period ON routine_triggers(routine_id, period_key);

-- Index for reminder lookups
CREATE INDEX IF NOT EXISTS idx_reminders_due_at ON reminders(due_at);
CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status);
`;

/**
 * Ensure the memory directory exists
 */
async function ensureMemoryDir(): Promise<void> {
  try {
    await mkdir(MEMORY_DIR, { recursive: true });
    await mkdir(join(MEMORY_DIR, "screenshots"), { recursive: true });
    await mkdir(join(MEMORY_DIR, "daily"), { recursive: true });
  } catch (error) {
    // Directory might already exist
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}

function ensurePreSchemaCompatibility(database: Database): void {
  const interactionsExists = database
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='interactions'")
    .get();
  if (interactionsExists) {
    const columns = database.query("PRAGMA table_info(interactions)").all() as { name: string }[];
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("turn_id")) database.exec("ALTER TABLE interactions ADD COLUMN turn_id TEXT");
    if (!names.has("sequence")) database.exec("ALTER TABLE interactions ADD COLUMN sequence INTEGER");
    if (!names.has("kind")) database.exec("ALTER TABLE interactions ADD COLUMN kind TEXT DEFAULT 'message'");
    if (!names.has("modality")) database.exec("ALTER TABLE interactions ADD COLUMN modality TEXT");
    if (!names.has("source")) database.exec("ALTER TABLE interactions ADD COLUMN source TEXT");
  }

  const screenshotsExists = database
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='screenshots'")
    .get();
  if (screenshotsExists) {
    const columns = database.query("PRAGMA table_info(screenshots)").all() as { name: string }[];
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("session_id")) database.exec("ALTER TABLE screenshots ADD COLUMN session_id TEXT");
    if (!names.has("turn_id")) database.exec("ALTER TABLE screenshots ADD COLUMN turn_id TEXT");
  }

  const appStateExists = database
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='app_state'")
    .get();
  if (appStateExists) {
    const columns = database.query("PRAGMA table_info(app_state)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "value_type")) {
      database.exec("ALTER TABLE app_state ADD COLUMN value_type TEXT NOT NULL DEFAULT 'json'");
    }
  }
}

async function backupCorruptDatabaseIfPresent(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  if (!existsSync(DB_PATH)) return;
  if (!/malformed|corrupt|not a database|file is not a database|database disk image/i.test(message)) return;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupBase = join(MEMORY_DIR, `memory.corrupt.${timestamp}`);
  try {
    await copyFile(DB_PATH, `${backupBase}.db`);
    if (existsSync(`${DB_PATH}-wal`)) {
      await copyFile(`${DB_PATH}-wal`, `${backupBase}.db-wal`);
    }
    if (existsSync(`${DB_PATH}-shm`)) {
      await copyFile(`${DB_PATH}-shm`, `${backupBase}.db-shm`);
    }
    logWarn("[Memory DB] Backed up corrupt database to", backupBase);
  } catch (backupError) {
    logWarn("[Memory DB] Failed to back up corrupt database:", backupError);
  }
}

/**
 * Initialize the database
 */
export async function initDatabase(): Promise<Database> {
  if (db) {
    return db;
  }

  try {
    await ensureMemoryDir();

    db = new Database(DB_PATH);

    // Enable WAL mode for better concurrent access
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");

    // Bring existing pre-plan databases forward enough that CREATE VIEW statements
    // referencing new columns do not fail before migrations get a chance to run.
    ensurePreSchemaCompatibility(db);

    // Create schema
    db.exec(SCHEMA_SQL);

    logInfo("[Memory DB] Database initialized at", DB_PATH);
    return db;
  } catch (error) {
    await backupCorruptDatabaseIfPresent(error);
    logError("[Memory DB] Failed to initialize database:", error);
    throw error;
  }
}

/**
 * Get the database instance (must call initDatabase first)
 */
export function getDatabase(): Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return db;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    logInfo("[Memory DB] Database connection closed");
  }
}

/**
 * Get the memory directory path
 */
export function getMemoryDir(): string {
  return MEMORY_DIR;
}

/**
 * Get the screenshots directory path
 */
export function getScreenshotsDir(): string {
  return join(MEMORY_DIR, "screenshots");
}

/**
 * Get the daily summaries directory path
 */
export function getDailyDir(): string {
  return join(MEMORY_DIR, "daily");
}

/**
 * Get the user profile path
 */
export function getUserProfilePath(): string {
  return join(MEMORY_DIR, "user_profile.md");
}

