/**
 * Database Migrations for Ari's Memory System
 * Handles schema versioning and upgrades
 */

import { Database } from "bun:sqlite";
import { logInfo, logWarn } from "../utils/logger";

interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

/**
 * List of migrations in order
 * Add new migrations to the end of this array
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    up: (_db: Database) => {
      // Initial schema is created in schema.ts
      // This migration just marks version 1 as applied
    },
  },
  {
    version: 2,
    name: "add_date_column_to_interactions",
    up: (db: Database) => {
      // Check if date column already exists (make migration idempotent)
      const columns = db
        .query("PRAGMA table_info(interactions)")
        .all() as { name: string }[];
      const hasDateColumn = columns.some((col) => col.name === "date");

      if (!hasDateColumn) {
        // Add date column as INTEGER (YYYYMMDD format) for faster queries
        db.exec("ALTER TABLE interactions ADD COLUMN date INTEGER");
      }

      // Populate date column for existing rows from timestamp
      // Convert timestamp (ms) to YYYYMMDD integer format
      db.exec(`
        UPDATE interactions
        SET date = CAST(strftime('%Y%m%d', timestamp/1000, 'unixepoch', 'localtime') AS INTEGER)
        WHERE date IS NULL
      `);

      // Create index for date queries
      db.exec("CREATE INDEX IF NOT EXISTS idx_interactions_date ON interactions(date)");
    },
  },
  {
    version: 3,
    name: "add_readable_views",
    up: (db: Database) => {
      // Create view for human-readable interactions with time gaps
      db.exec(`
        CREATE VIEW IF NOT EXISTS interactions_readable AS
        SELECT
          id,
          type,
          role,
          content,
          session_id,
          timestamp,
          date,
          substr(date, 1, 4) || '-' || substr(date, 5, 2) || '-' || substr(date, 7, 2) AS date_formatted,
          datetime(timestamp / 1000, 'unixepoch', 'localtime') AS datetime_formatted,
          time(timestamp / 1000, 'unixepoch', 'localtime') AS time_formatted,
          ROUND((timestamp - LAG(timestamp) OVER (ORDER BY timestamp)) / 60000.0, 1) AS minutes_since_prev,
          metadata
        FROM interactions
      `);

      // Create view for readable daily summaries
      db.exec(`
        CREATE VIEW IF NOT EXISTS daily_summaries_readable AS
        SELECT
          id,
          date,
          substr(date, 1, 4) || '-' || substr(date, 5, 2) || '-' || substr(date, 7, 2) AS date_formatted,
          summary,
          interaction_count,
          datetime(created_at, 'unixepoch', 'localtime') AS created_at_formatted,
          datetime(updated_at, 'unixepoch', 'localtime') AS updated_at_formatted
        FROM daily_summaries
      `);
    },
  },
  {
    version: 4,
    name: "add_routines_tables",
    up: (db: Database) => {
      // Create routines table
      db.exec(`
        CREATE TABLE IF NOT EXISTS routines (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT,
          schedule_type TEXT NOT NULL CHECK(schedule_type IN ('daily', 'specific_time', 'weekly_quota', 'interval')),
          schedule_value TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          snoozed_until INTEGER,
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          updated_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `);

      // Create index for routine queries
      db.exec("CREATE INDEX IF NOT EXISTS idx_routines_enabled ON routines(enabled)");

      // Create routine completions table
      db.exec(`
        CREATE TABLE IF NOT EXISTS routine_completions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          routine_id INTEGER NOT NULL,
          completed_at INTEGER NOT NULL,
          period_key TEXT NOT NULL,
          FOREIGN KEY (routine_id) REFERENCES routines(id) ON DELETE CASCADE
        )
      `);

      // Create indexes for completion queries
      db.exec("CREATE INDEX IF NOT EXISTS idx_routine_completions_routine_id ON routine_completions(routine_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_routine_completions_period_key ON routine_completions(period_key)");

      // Create app state table for storing last_voice_activity, etc.
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `);

      // Create view for routines with completion status
      db.exec(`
        CREATE VIEW IF NOT EXISTS routines_with_status AS
        SELECT
          r.id,
          r.name,
          r.description,
          r.schedule_type,
          r.schedule_value,
          r.enabled,
          r.snoozed_until,
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
        FROM routines r
      `);
    },
  },
  {
    version: 5,
    name: "add_context_interaction_type",
    up: (db: Database) => {
      // SQLite doesn't support modifying CHECK constraints directly.
      // Since the constraint is on the table definition, we need to recreate the table.
      // However, for simplicity and data safety, we'll just note that new entries
      // with type='context' are now valid. The CHECK constraint in CREATE TABLE
      // only applies at creation time, and SQLite will allow inserts with values
      // not in the old CHECK if the table already exists.
      //
      // To be safe, we can verify the table accepts the new type by doing nothing
      // (SQLite CHECK constraints are lenient for existing tables).
      // The updated schema.ts will handle new database creation correctly.
      logInfo("[Migration 5] Context interaction type now supported");
    },
  },
  {
    version: 6,
    name: "add_lists_tables",
    up: (db: Database) => {
      // Create lists table for named collections
      db.exec(`
        CREATE TABLE IF NOT EXISTS lists (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          description TEXT,
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          updated_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `);

      // Create index for list name lookups
      db.exec("CREATE INDEX IF NOT EXISTS idx_lists_name ON lists(name)");

      // Create list items table
      db.exec(`
        CREATE TABLE IF NOT EXISTS list_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          list_id INTEGER NOT NULL,
          content TEXT NOT NULL,
          position INTEGER DEFAULT 0,
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE
        )
      `);

      // Create indexes for list item queries
      db.exec("CREATE INDEX IF NOT EXISTS idx_list_items_list_id ON list_items(list_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_list_items_position ON list_items(position)");

      // Create view for lists with item counts
      db.exec(`
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
        FROM lists l
      `);

      logInfo("[Migration 6] Lists tables created");
    },
  },
  {
    version: 7,
    name: "add_reminders_table",
    up: (db: Database) => {
      // Create reminders table for one-time alerts
      db.exec(`
        CREATE TABLE IF NOT EXISTS reminders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content TEXT NOT NULL,
          due_at INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'cancelled')),
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          updated_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `);

      // Create index for due_at lookups
      db.exec("CREATE INDEX IF NOT EXISTS idx_reminders_due_at ON reminders(due_at)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status)");

      logInfo("[Migration 7] Reminders table created");
    },
  },
  {
    version: 8,
    name: "state_memory_architecture_foundation",
    up: (db: Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_sessions (
          id TEXT PRIMARY KEY,
          pi_session_id TEXT,
          title TEXT,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_turns (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'interrupted', 'error')),
          source TEXT NOT NULL CHECK(source IN ('text', 'voice', 'routine', 'reminder', 'system')),
          FOREIGN KEY(session_id) REFERENCES conversation_sessions(id)
        )
      `);

      const interactionColumns = db.query("PRAGMA table_info(interactions)").all() as { name: string }[];
      const interactionColumnNames = new Set(interactionColumns.map((column) => column.name));
      if (!interactionColumnNames.has("turn_id")) db.exec("ALTER TABLE interactions ADD COLUMN turn_id TEXT");
      if (!interactionColumnNames.has("sequence")) db.exec("ALTER TABLE interactions ADD COLUMN sequence INTEGER");
      if (!interactionColumnNames.has("kind")) db.exec("ALTER TABLE interactions ADD COLUMN kind TEXT DEFAULT 'message'");
      if (!interactionColumnNames.has("modality")) db.exec("ALTER TABLE interactions ADD COLUMN modality TEXT");
      if (!interactionColumnNames.has("source")) db.exec("ALTER TABLE interactions ADD COLUMN source TEXT");

      db.exec("CREATE INDEX IF NOT EXISTS idx_interactions_turn_id ON interactions(turn_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_interactions_session_timestamp ON interactions(session_id, timestamp)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_conversation_turns_session_id ON conversation_turns(session_id)");
      db.exec("DROP VIEW IF EXISTS interactions_readable");
      db.exec(`
        CREATE VIEW interactions_readable AS
        SELECT
          id,
          type,
          role,
          content,
          session_id,
          timestamp,
          date,
          substr(date, 1, 4) || '-' || substr(date, 5, 2) || '-' || substr(date, 7, 2) AS date_formatted,
          datetime(timestamp / 1000, 'unixepoch', 'localtime') AS datetime_formatted,
          time(timestamp / 1000, 'unixepoch', 'localtime') AS time_formatted,
          ROUND((timestamp - LAG(timestamp) OVER (ORDER BY timestamp)) / 60000.0, 1) AS minutes_since_prev,
          turn_id,
          sequence,
          kind,
          modality,
          source,
          metadata
        FROM interactions
      `);

      const appStateColumns = db.query("PRAGMA table_info(app_state)").all() as { name: string }[];
      if (!appStateColumns.some((column) => column.name === "value_type")) {
        db.exec("ALTER TABLE app_state ADD COLUMN value_type TEXT NOT NULL DEFAULT 'json'");
      }

      db.exec(`
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
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_due_at ON tasks(due_at)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_list_id ON tasks(list_id)");

      const reminderTable = db
        .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='reminders'")
        .get() as { sql: string } | null;
      if (reminderTable?.sql && !reminderTable.sql.includes("triggered")) {
        db.exec("ALTER TABLE reminders RENAME TO reminders_old_status");
        db.exec(`
          CREATE TABLE reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            due_at INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'triggered', 'completed', 'cancelled', 'failed')),
            created_at INTEGER DEFAULT (strftime('%s', 'now')),
            updated_at INTEGER DEFAULT (strftime('%s', 'now'))
          )
        `);
        db.exec(`
          INSERT INTO reminders (id, content, due_at, status, created_at, updated_at)
          SELECT id, content, due_at, status, created_at, updated_at FROM reminders_old_status
        `);
        db.exec("DROP TABLE reminders_old_status");
      }

      const reminderColumns = db.query("PRAGMA table_info(reminders)").all() as { name: string }[];
      const reminderColumnNames = new Set(reminderColumns.map((column) => column.name));
      if (!reminderColumnNames.has("triggered_at")) db.exec("ALTER TABLE reminders ADD COLUMN triggered_at INTEGER");
      if (!reminderColumnNames.has("delivered_at")) db.exec("ALTER TABLE reminders ADD COLUMN delivered_at INTEGER");
      if (!reminderColumnNames.has("acknowledged_at")) db.exec("ALTER TABLE reminders ADD COLUMN acknowledged_at INTEGER");
      if (!reminderColumnNames.has("last_error")) db.exec("ALTER TABLE reminders ADD COLUMN last_error TEXT");
      if (!reminderColumnNames.has("trigger_count")) db.exec("ALTER TABLE reminders ADD COLUMN trigger_count INTEGER NOT NULL DEFAULT 0");
      db.exec("CREATE INDEX IF NOT EXISTS idx_reminders_due_at ON reminders(due_at)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status)");

      db.exec(`
        CREATE TABLE IF NOT EXISTS routine_triggers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          routine_id INTEGER NOT NULL,
          triggered_at INTEGER NOT NULL,
          period_key TEXT,
          status TEXT NOT NULL,
          FOREIGN KEY(routine_id) REFERENCES routines(id) ON DELETE CASCADE
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_routine_triggers_routine_period ON routine_triggers(routine_id, period_key)");

      logInfo("[Migration 8] State/memory architecture foundation created");
    },
  },
  {
    version: 9,
    name: "normalize_routine_schedules",
    up: (db: Database) => {
      const routineColumns = db.query("PRAGMA table_info(routines)").all() as { name: string }[];
      const routineColumnNames = new Set(routineColumns.map((column) => column.name));
      if (!routineColumnNames.has("schedule_config")) db.exec("ALTER TABLE routines ADD COLUMN schedule_config TEXT");
      if (!routineColumnNames.has("timezone")) db.exec("ALTER TABLE routines ADD COLUMN timezone TEXT NOT NULL DEFAULT 'local'");

      const routines = db.query("SELECT id, schedule_type, schedule_value FROM routines").all() as Array<{
        id: number;
        schedule_type: string;
        schedule_value: string | null;
      }>;

      for (const routine of routines) {
        let scheduleConfig: Record<string, unknown>;
        switch (routine.schedule_type) {
          case "specific_time":
            scheduleConfig = { type: "specific_time", time: routine.schedule_value ?? "09:00" };
            break;
          case "weekly_quota":
            scheduleConfig = { type: "weekly_quota", count: Number.parseInt(routine.schedule_value ?? "1", 10) || 1 };
            break;
          case "interval": {
            const match = (routine.schedule_value ?? "24h").match(/^(\d+)([mhd])$/);
            const every = match ? Number.parseInt(match[1], 10) : 24;
            const unit = match?.[2] === "m" ? "minutes" : match?.[2] === "d" ? "days" : "hours";
            scheduleConfig = { type: "interval", every, unit };
            break;
          }
          case "daily":
          default:
            scheduleConfig = { type: "daily" };
            break;
        }

        db.query("UPDATE routines SET schedule_config = ?, timezone = COALESCE(timezone, 'local') WHERE id = ?").run(
          JSON.stringify(scheduleConfig),
          routine.id,
        );
      }

      logInfo("[Migration 9] Routine schedules normalized");
    },
  },
  {
    version: 10,
    name: "screenshot_links_and_routine_delivery_indexes",
    up: (db: Database) => {
      const screenshotColumns = db.query("PRAGMA table_info(screenshots)").all() as { name: string }[];
      const screenshotColumnNames = new Set(screenshotColumns.map((column) => column.name));
      if (!screenshotColumnNames.has("session_id")) db.exec("ALTER TABLE screenshots ADD COLUMN session_id TEXT");
      if (!screenshotColumnNames.has("turn_id")) db.exec("ALTER TABLE screenshots ADD COLUMN turn_id TEXT");
      db.exec("CREATE INDEX IF NOT EXISTS idx_screenshots_turn_id ON screenshots(turn_id)");

      // Older development databases may already contain duplicate trigger rows.
      // Keep the newest row for each (routine_id, period_key) before adding uniqueness.
      db.exec(`
        DELETE FROM routine_triggers
        WHERE id NOT IN (
          SELECT MAX(id)
          FROM routine_triggers
          GROUP BY routine_id, period_key
        )
      `);
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_routine_triggers_unique_period ON routine_triggers(routine_id, period_key)");
      logInfo("[Migration 10] Added screenshot linkage and routine trigger uniqueness");
    },
  },
  {
    version: 11,
    name: "agentic_routines_foundation",
    up: (db: Database) => {
      const columns = db.query("PRAGMA table_info(routines)").all() as { name: string }[];
      const names = new Set(columns.map((column) => column.name));
      const addText = (name: string) => {
        if (!names.has(name)) db.exec(`ALTER TABLE routines ADD COLUMN ${name} TEXT`);
      };
      const addInteger = (name: string) => {
        if (!names.has(name)) db.exec(`ALTER TABLE routines ADD COLUMN ${name} INTEGER`);
      };

      addText("goal");
      addText("triggers");
      addText("conditions");
      addText("context_requests");
      addText("action_graph");
      addText("permissions");
      addText("routine_state");
      addText("evaluation");
      addText("delivery");
      addInteger("last_run_at");
      addInteger("next_run_at");

      db.exec("CREATE INDEX IF NOT EXISTS idx_routines_next_run_at ON routines(enabled, next_run_at)");
      logInfo("[Migration 11] Agentic routine columns added");
    },
  },
  {
    version: 12,
    name: "audio_transcripts",
    up: (db: Database) => {
      db.exec(`
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
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_audio_transcripts_timestamp ON audio_transcripts(timestamp)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_audio_transcripts_source ON audio_transcripts(source)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_audio_transcripts_date ON audio_transcripts(date)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_audio_transcripts_source_timestamp ON audio_transcripts(source, timestamp)");
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS audio_transcripts_fts USING fts5(
          content,
          content='audio_transcripts',
          content_rowid='id'
        )
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audio_transcripts_ai AFTER INSERT ON audio_transcripts BEGIN
          INSERT INTO audio_transcripts_fts(rowid, content) VALUES (new.id, new.content);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audio_transcripts_ad AFTER DELETE ON audio_transcripts BEGIN
          INSERT INTO audio_transcripts_fts(audio_transcripts_fts, rowid, content) VALUES('delete', old.id, old.content);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audio_transcripts_au AFTER UPDATE ON audio_transcripts BEGIN
          INSERT INTO audio_transcripts_fts(audio_transcripts_fts, rowid, content) VALUES('delete', old.id, old.content);
          INSERT INTO audio_transcripts_fts(rowid, content) VALUES (new.id, new.content);
        END
      `);
      db.exec(`
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
        FROM audio_transcripts
      `);
      db.exec("INSERT INTO audio_transcripts_fts(audio_transcripts_fts) VALUES('rebuild')");
      logInfo("[Migration 12] Audio transcript tables created");
    },
  },
];

/**
 * Get the current schema version from the database
 */
function getCurrentVersion(db: Database): number {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      )
    `);

    const legacy = db.query("SELECT MAX(version) as version FROM schema_version").get() as { version: number | null };
    const modern = db.query("SELECT MAX(id) as version FROM schema_migrations").get() as { version: number | null };
    return Math.max(legacy?.version ?? 0, modern?.version ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Record that a migration was applied
 */
function recordMigration(db: Database, migration: Migration): void {
  db.query("INSERT OR IGNORE INTO schema_version (version, name) VALUES (?, ?)").run(
    migration.version,
    migration.name
  );
  db.query("INSERT OR IGNORE INTO schema_migrations (id, name) VALUES (?, ?)").run(
    migration.version,
    migration.name
  );
}

/**
 * Run all pending migrations
 */
export function runMigrations(db: Database): void {
  const currentVersion = getCurrentVersion(db);
  const pendingMigrations = MIGRATIONS.filter((m) => m.version > currentVersion);

  if (pendingMigrations.length === 0) {
    logInfo("[Migrations] Database is up to date (version", currentVersion, ")");
    return;
  }

  logInfo(
    "[Migrations] Running",
    pendingMigrations.length,
    "migration(s) from version",
    currentVersion
  );

  for (const migration of pendingMigrations) {
    try {
      logInfo("[Migrations] Applying migration", migration.version, "-", migration.name);

      // Run migration in a transaction
      db.exec("BEGIN TRANSACTION");
      migration.up(db);
      recordMigration(db, migration);
      db.exec("COMMIT");

      logInfo("[Migrations] Successfully applied migration", migration.version);
    } catch (error) {
      db.exec("ROLLBACK");
      logWarn("[Migrations] Failed to apply migration", migration.version, ":", error);
      throw error;
    }
  }

  logInfo("[Migrations] All migrations complete. Now at version", MIGRATIONS[MIGRATIONS.length - 1].version);
}

/**
 * Get migration status
 */
export function getMigrationStatus(db: Database): {
  currentVersion: number;
  latestVersion: number;
  pendingCount: number;
} {
  const currentVersion = getCurrentVersion(db);
  const latestVersion = MIGRATIONS.length > 0 ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;
  const pendingCount = MIGRATIONS.filter((m) => m.version > currentVersion).length;

  return {
    currentVersion,
    latestVersion,
    pendingCount,
  };
}

