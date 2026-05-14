/**
 * Routines Service for Ari
 * Manages routines/reminders with CRUD, completion tracking, and snooze logic
 */

import { getDatabase, type Routine, type RoutineCompletion, type ScheduleType } from "../db";
import { getSetting, setSetting } from "./app-state";
import { logInfo, logDebug, logWarn } from "../utils/logger";

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the current date as YYYY-MM-DD string
 */
function getDateParts(timeZone?: string, now: Date = new Date()) {
  if (!timeZone || timeZone === "local") {
    return {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
      hour: now.getHours(),
      minute: now.getMinutes(),
    };
  }

  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
      year: Number.parseInt(map.year, 10),
      month: Number.parseInt(map.month, 10),
      day: Number.parseInt(map.day, 10),
      hour: Number.parseInt(map.hour, 10),
      minute: Number.parseInt(map.minute, 10),
    };
  } catch {
    return {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
      hour: now.getHours(),
      minute: now.getMinutes(),
    };
  }
}

function getTodayDateString(timeZone?: string, now: Date = new Date()): string {
  const d = getDateParts(timeZone, now);
  const yyyy = d.year;
  const mm = String(d.month).padStart(2, "0");
  const dd = String(d.day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Get the current ISO week as YYYY-Www string (e.g., "2026-W02")
 */
function getCurrentISOWeek(timeZone?: string, now: Date = new Date()): string {
  const parts = getDateParts(timeZone, now);
  const date = new Date(parts.year, parts.month - 1, parts.day);
  const day = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - day + 3);

  const isoYear = date.getFullYear();
  const firstThursday = new Date(isoYear, 0, 4);
  const firstDay = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDay + 3);

  const weekNo = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${isoYear}-W${String(weekNo).padStart(2, "0")}`;
}

/**
 * Get the current time as HH:MM string
 */
function getCurrentTime(timeZone?: string, now: Date = new Date()): string {
  const parts = getDateParts(timeZone, now);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

/**
 * Parse duration string (e.g., "2h", "30m", "1d") to milliseconds
 */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([mhd])$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}. Use formats like "30m", "2h", "1d"`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }
}

export type RoutineScheduleConfig =
  | { type: "daily" }
  | { type: "specific_time"; time: string }
  | { type: "weekly_quota"; count: number }
  | { type: "interval"; every: number; unit: "minutes" | "hours" | "days" };

export type AgenticRoutineTrigger =
  | { type: "schedule"; schedule: RoutineScheduleConfig }
  | { type: "manual" }
  | { type: "app"; app: string; event?: "opened" | "focused" }
  | { type: "phrase"; phrase: string }
  | { type: "context"; signal: string };

export type AgenticRoutineCondition =
  | { type: "quiet_hours"; start: string; end: string; mode?: "block" | "silent" }
  | { type: "cooldown"; duration: string }
  | { type: "ask_before_interrupting" }
  | { type: "only_if_active"; withinMinutes?: number }
  | { type: "not_in_meeting" };

export type RoutineAction =
  | { type: "ask_ari"; prompt: string; includeScreenshot?: boolean; delivery?: "speak" | "silent" | "bubble" }
  | { type: "notify"; message: string; speak?: boolean }
  | { type: "complete_routine" }
  | { type: "create_task"; title: string; description?: string; priority?: "low" | "normal" | "high" };

export interface AgenticRoutineSpec {
  name: string;
  goal: string;
  description?: string;
  triggers?: AgenticRoutineTrigger[];
  conditions?: AgenticRoutineCondition[];
  contextRequests?: Array<{ type: "memory" | "screen" | "calendar" | "tasks" | "time"; query?: string; optional?: boolean }>;
  actionGraph?: { actions: RoutineAction[]; description?: string };
  permissions?: { read?: string[]; notify?: boolean; act?: string[]; external?: "ask" | "deny" | "allow" };
  evaluation?: { askForFeedback?: boolean; successSignals?: string[] };
  delivery?: { tts?: "always" | "urgent-only" | "never"; style?: string; interruptibility?: "low" | "normal" | "high" };
  timezone?: string;
  enabled?: boolean;
}

function serializeScheduleConfig(scheduleType: ScheduleType, scheduleValue?: string): RoutineScheduleConfig {
  switch (scheduleType) {
    case "specific_time":
      return { type: "specific_time", time: scheduleValue ?? "09:00" };
    case "weekly_quota":
      return { type: "weekly_quota", count: Number.parseInt(scheduleValue ?? "1", 10) || 1 };
    case "interval": {
      const match = (scheduleValue ?? "24h").match(/^(\d+)([mhd])$/);
      const every = match ? Number.parseInt(match[1], 10) : 24;
      const unit = match?.[2] === "m" ? "minutes" : match?.[2] === "d" ? "days" : "hours";
      return { type: "interval", every, unit };
    }
    case "daily":
    default:
      return { type: "daily" };
  }
}

function stringifyScheduleValue(config: RoutineScheduleConfig): string | null {
  switch (config.type) {
    case "daily":
      return null;
    case "specific_time":
      return config.time;
    case "weekly_quota":
      return String(config.count);
    case "interval":
      return `${config.every}${config.unit === "minutes" ? "m" : config.unit === "days" ? "d" : "h"}`;
  }
}

export function getRoutineScheduleConfig(routine: Routine): RoutineScheduleConfig {
  if (routine.schedule_config) {
    try {
      const parsed = JSON.parse(routine.schedule_config) as RoutineScheduleConfig;
      if (parsed && parsed.type) {
        return parsed;
      }
    } catch {
      // fall through to legacy schedule_value parsing
    }
  }

  return serializeScheduleConfig(routine.schedule_type, routine.schedule_value ?? undefined);
}

function getRoutinePeriodKey(routine: Routine, now: Date = new Date()): string {
  const config = getRoutineScheduleConfig(routine);
  if (config.type === "weekly_quota") return getCurrentISOWeek(routine.timezone ?? undefined, now);
  if (config.type === "interval") {
    const bucketUnitMs = config.unit === "minutes" ? 60_000 : config.unit === "days" ? 86_400_000 : 3_600_000;
    const bucket = Math.floor(now.getTime() / (config.every * bucketUnitMs));
    return `interval:${routine.id}:${bucket}`;
  }
  return getTodayDateString(routine.timezone ?? undefined, now);
}

// ============================================================================
// Time/epoch normalization (backwards compatibility)
// ============================================================================

/**
 * Normalize an epoch value that may be in milliseconds (older data) to seconds.
 */
function normalizeEpochSeconds(value: number | null): number | null {
  if (value === null || value === undefined) return null;
  // If it's bigger than ~Sat Nov 20 2286 in seconds, it's almost certainly ms.
  if (value > 1_000_000_000_000) {
    return Math.floor(value / 1000);
  }
  return value;
}

/**
 * If a routine's snoozed_until looks like it's in ms, convert it in-place in the DB once.
 */
function normalizeRoutineSnoozeIfNeeded(routine: Routine): Routine {
  if (!routine.snoozed_until) return routine;
  const normalized = normalizeEpochSeconds(routine.snoozed_until);
  if (normalized === null || normalized === routine.snoozed_until) return routine;

  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);
  db.query("UPDATE routines SET snoozed_until = ?, updated_at = ? WHERE id = ?").run(normalized, now, routine.id);
  logInfo("[Routines] Normalized snoozed_until from ms -> seconds for routine:", routine.id, routine.name);
  return { ...routine, snoozed_until: normalized };
}

// ============================================================================
// Routine CRUD Operations
// ============================================================================

/**
 * Create a new routine
 */
export function createRoutine(params: {
  name: string;
  description?: string;
  scheduleType: ScheduleType;
  scheduleValue?: string;
  timezone?: string;
}): Routine {
  const scheduleConfig = serializeScheduleConfig(params.scheduleType, params.scheduleValue);
  return createAgenticRoutine({
    name: params.name,
    description: params.description,
    goal: params.description ?? params.name,
    triggers: [{ type: "schedule", schedule: scheduleConfig }],
    actionGraph: { actions: [{ type: "ask_ari", prompt: params.description ?? params.name }] },
    timezone: params.timezone,
  });
}

export function createAgenticRoutine(spec: AgenticRoutineSpec): Routine {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);
  const primarySchedule = spec.triggers?.find((trigger) => trigger.type === "schedule")?.schedule ?? { type: "daily" };
  const scheduleType = primarySchedule.type as ScheduleType;

  const result = db
    .query(
      `INSERT INTO routines (
        name, description, schedule_type, schedule_value, schedule_config, timezone,
        goal, triggers, conditions, context_requests, action_graph, permissions, routine_state, evaluation, delivery,
        enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      spec.name,
      spec.description ?? null,
      scheduleType,
      stringifyScheduleValue(primarySchedule),
      JSON.stringify(primarySchedule),
      spec.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "local"),
      spec.goal,
      JSON.stringify(spec.triggers ?? [{ type: "schedule", schedule: primarySchedule }]),
      JSON.stringify(spec.conditions ?? []),
      JSON.stringify(spec.contextRequests ?? [{ type: "time" }]),
      JSON.stringify(spec.actionGraph ?? { actions: [{ type: "ask_ari", prompt: spec.goal }] }),
      JSON.stringify(spec.permissions ?? { read: ["time", "memory", "tasks"], notify: true, act: [], external: "ask" }),
      JSON.stringify({ createdBy: "agentic_routine", feedback: [], runCount: 0 }),
      JSON.stringify(spec.evaluation ?? { askForFeedback: false, successSignals: [] }),
      JSON.stringify(spec.delivery ?? { tts: "always", style: "ari", interruptibility: "normal" }),
      spec.enabled === false ? 0 : 1,
      now,
      now
    );

  const routine = getRoutineById(Number(result.lastInsertRowid))!;
  logInfo("[Routines] Created agentic routine:", routine.name, "id:", routine.id);
  return routine;
}

/**
 * Get a routine by ID
 */
export function getRoutineById(id: number): Routine | null {
  const db = getDatabase();
  const routine = db.query("SELECT * FROM routines WHERE id = ?").get(id) as Routine | null;
  return routine ? normalizeRoutineSnoozeIfNeeded(routine) : null;
}

/**
 * Get all routines
 */
export function getAllRoutines(): Routine[] {
  const db = getDatabase();
  const routines = db.query("SELECT * FROM routines ORDER BY created_at DESC").all() as Routine[];
  return routines.map(normalizeRoutineSnoozeIfNeeded);
}

/**
 * Get enabled routines
 */
export function getEnabledRoutines(): Routine[] {
  const db = getDatabase();
  const routines = db.query("SELECT * FROM routines WHERE enabled = 1 ORDER BY created_at DESC").all() as Routine[];
  return routines.map(normalizeRoutineSnoozeIfNeeded);
}

/**
 * Update a routine
 */
export function updateRoutine(
  id: number,
  params: {
    name?: string;
    description?: string;
    scheduleType?: ScheduleType;
    scheduleValue?: string;
    timezone?: string;
    enabled?: boolean;
  }
): Routine | null {
  const db = getDatabase();
  const existing = getRoutineById(id);
  if (!existing) {
    return null;
  }

  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (params.name !== undefined) {
    updates.push("name = ?");
    values.push(params.name);
  }

  if (params.description !== undefined) {
    updates.push("description = ?");
    values.push(params.description);
  }

  const nextScheduleType = params.scheduleType ?? existing.schedule_type;
  const nextScheduleValue = params.scheduleValue ?? existing.schedule_value ?? undefined;

  if (params.scheduleType !== undefined) {
    updates.push("schedule_type = ?");
    values.push(params.scheduleType);
  }

  if (params.scheduleType !== undefined || params.scheduleValue !== undefined) {
    const nextConfig = serializeScheduleConfig(nextScheduleType, nextScheduleValue);
    updates.push("schedule_config = ?");
    values.push(JSON.stringify(nextConfig));
    updates.push("schedule_value = ?");
    values.push(stringifyScheduleValue(nextConfig));
  }

  if (params.timezone !== undefined) {
    updates.push("timezone = ?");
    values.push(params.timezone);
  }

  if (params.enabled !== undefined) {
    updates.push("enabled = ?");
    values.push(params.enabled ? 1 : 0);
  }

  if (updates.length === 0) {
    return existing;
  }

  updates.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);

  db.query(`UPDATE routines SET ${updates.join(", ")} WHERE id = ?`).run(...values);

  logDebug("[Routines] Updated routine:", id);
  return getRoutineById(id);
}

/**
 * Delete a routine
 */
export function deleteRoutine(id: number): boolean {
  const db = getDatabase();
  const result = db.query("DELETE FROM routines WHERE id = ?").run(id);
  if (result.changes > 0) {
    logInfo("[Routines] Deleted routine:", id);
    return true;
  }
  return false;
}

/**
 * Toggle a routine's enabled status
 */
export function toggleRoutine(id: number): Routine | null {
  const existing = getRoutineById(id);
  if (!existing) {
    return null;
  }

  return updateRoutine(id, { enabled: existing.enabled === 0 });
}

// ============================================================================
// Completion Tracking
// ============================================================================

/**
 * Mark a routine as completed
 */
export function completeRoutine(routineId: number): RoutineCompletion | null {
  const db = getDatabase();
  const routine = getRoutineById(routineId);

  if (!routine) {
    logWarn("[Routines] Cannot complete non-existent routine:", routineId);
    return null;
  }

  // Determine the period key based on schedule type
  let periodKey: string;
  if (routine.schedule_type === "weekly_quota") {
    periodKey = getCurrentISOWeek(routine.timezone ?? undefined);
  } else {
    periodKey = getTodayDateString(routine.timezone ?? undefined);
  }

  const now = Math.floor(Date.now() / 1000);

  const result = db
    .query(
      `INSERT INTO routine_completions (routine_id, completed_at, period_key)
       VALUES (?, ?, ?)`
    )
    .run(routineId, now, periodKey);

  // Also clear any snooze
  db.query("UPDATE routines SET snoozed_until = NULL, updated_at = ? WHERE id = ?").run(now, routineId);

  logInfo("[Routines] Completed routine:", routine.name, "period:", periodKey);

  return {
    id: Number(result.lastInsertRowid),
    routine_id: routineId,
    completed_at: now,
    period_key: periodKey,
  };
}

/**
 * Undo (un-complete) a routine for the current period.
 *
 * Behavior:
 * - daily/specific_time: removes the most recent completion for today
 * - weekly_quota: removes the most recent completion for the current ISO week
 * - interval: removes the most recent completion overall
 *
 * Returns the removed completion record if one existed, otherwise null.
 */
export function uncompleteRoutine(routineId: number): RoutineCompletion | null {
  const db = getDatabase();
  const routine = getRoutineById(routineId);

  if (!routine) {
    logWarn("[Routines] Cannot uncomplete non-existent routine:", routineId);
    return null;
  }

  // Find the completion to remove
  let completionToRemove: RoutineCompletion | null = null;

  if (routine.schedule_type === "interval") {
    completionToRemove = db
      .query("SELECT * FROM routine_completions WHERE routine_id = ? ORDER BY completed_at DESC LIMIT 1")
      .get(routineId) as RoutineCompletion | null;
  } else {
    const periodKey = routine.schedule_type === "weekly_quota"
      ? getCurrentISOWeek(routine.timezone ?? undefined)
      : getTodayDateString(routine.timezone ?? undefined);
    completionToRemove = db
      .query(
        "SELECT * FROM routine_completions WHERE routine_id = ? AND period_key = ? ORDER BY completed_at DESC LIMIT 1"
      )
      .get(routineId, periodKey) as RoutineCompletion | null;
  }

  if (!completionToRemove) {
    logDebug("[Routines] No completion found to undo for routine:", routineId);
    return null;
  }

  db.query("DELETE FROM routine_completions WHERE id = ?").run(completionToRemove.id);
  logInfo("[Routines] Undid completion for routine:", routine.name, "completionId:", completionToRemove.id);
  return completionToRemove;
}

/**
 * Get completions for a routine in a specific period
 */
export function getCompletionsForPeriod(routineId: number, periodKey: string): RoutineCompletion[] {
  const db = getDatabase();
  return db
    .query("SELECT * FROM routine_completions WHERE routine_id = ? AND period_key = ? ORDER BY completed_at DESC")
    .all(routineId, periodKey) as RoutineCompletion[];
}

/**
 * Get today's completions for a routine
 */
export function getTodayCompletions(routineId: number, timeZone?: string): RoutineCompletion[] {
  return getCompletionsForPeriod(routineId, getTodayDateString(timeZone));
}

/**
 * Get this week's completions for a routine
 */
export function getWeekCompletions(routineId: number, timeZone?: string): RoutineCompletion[] {
  return getCompletionsForPeriod(routineId, getCurrentISOWeek(timeZone));
}

export function hasTriggeredRoutineForCurrentPeriod(routine: Routine, now: Date = new Date()): boolean {
  const db = getDatabase();
  const periodKey = getRoutinePeriodKey(routine, now);
  const row = db
    .query("SELECT status, triggered_at FROM routine_triggers WHERE routine_id = ? AND period_key = ? LIMIT 1")
    .get(routine.id, periodKey) as { status: string; triggered_at: number } | null;
  if (!row) return false;
  if (row.status === "failed") return false;
  if (row.status === "pending" && row.triggered_at <= Math.floor(now.getTime() / 1000) - 5 * 60) {
    return false;
  }
  return true;
}

export function recordRoutineTrigger(routine: Routine, status: string = "pending", now: Date = new Date()): {
  id: number;
  routineId: number;
  periodKey: string;
} {
  const db = getDatabase();
  const periodKey = getRoutinePeriodKey(routine, now);
  const triggeredAt = Math.floor(now.getTime() / 1000);
  db.query(
    `INSERT INTO routine_triggers (routine_id, triggered_at, period_key, status)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(routine_id, period_key) DO UPDATE SET triggered_at = excluded.triggered_at, status = excluded.status`
  ).run(routine.id, triggeredAt, periodKey, status);

  const row = db
    .query("SELECT id FROM routine_triggers WHERE routine_id = ? AND period_key = ? LIMIT 1")
    .get(routine.id, periodKey) as { id: number } | null;
  if (!row) throw new Error(`Failed to record routine trigger for routine ${routine.id}`);
  return { id: row.id, routineId: routine.id, periodKey };
}

export function acknowledgeRoutineTrigger(triggerId: number, now: Date = new Date()): boolean {
  const db = getDatabase();
  const result = db.query(
    "UPDATE routine_triggers SET status = 'delivered', triggered_at = ? WHERE id = ?"
  ).run(Math.floor(now.getTime() / 1000), triggerId);
  return result.changes > 0;
}

export function failRoutineTrigger(triggerId: number, now: Date = new Date()): boolean {
  const db = getDatabase();
  const result = db.query(
    "UPDATE routine_triggers SET status = 'failed', triggered_at = ? WHERE id = ?"
  ).run(Math.floor(now.getTime() / 1000), triggerId);
  return result.changes > 0;
}

/**
 * Check if a routine is completed for the current period
 */
export function isRoutineCompleted(routine: Routine): boolean {
  const config = getRoutineScheduleConfig(routine);
  if (config.type === "weekly_quota") {
    const completions = getWeekCompletions(routine.id, routine.timezone ?? undefined);
    return completions.length >= config.count;
  } else if (config.type === "interval") {
    // For interval, check if enough time has passed since last completion
    const db = getDatabase();
    const lastCompletion = db
      .query("SELECT * FROM routine_completions WHERE routine_id = ? ORDER BY completed_at DESC LIMIT 1")
      .get(routine.id) as RoutineCompletion | null;

    if (!lastCompletion) {
      return false; // Never completed, so it's due
    }

    const interval = parseDuration(`${config.every}${config.unit === "minutes" ? "m" : config.unit === "days" ? "d" : "h"}`);
    const now = Date.now();
    const lastCompletedAt = lastCompletion.completed_at * 1000;
    return now - lastCompletedAt < interval;
  } else {
    // daily or specific_time
    const completions = getTodayCompletions(routine.id, routine.timezone ?? undefined);
    return completions.length > 0;
  }
}

// ============================================================================
// Snooze Feature
// ============================================================================

/**
 * Snooze a routine for a duration
 */
export function snoozeRoutine(routineId: number, duration: string): Routine | null {
  const db = getDatabase();
  const routine = getRoutineById(routineId);

  if (!routine) {
    logWarn("[Routines] Cannot snooze non-existent routine:", routineId);
    return null;
  }

  const durationMs = parseDuration(duration);
  const snoozedUntil = Math.floor((Date.now() + durationMs) / 1000);
  const now = Math.floor(Date.now() / 1000);

  db.query("UPDATE routines SET snoozed_until = ?, updated_at = ? WHERE id = ?").run(snoozedUntil, now, routineId);

  logInfo("[Routines] Snoozed routine:", routine.name, "until:", new Date(snoozedUntil * 1000).toLocaleString());

  return getRoutineById(routineId);
}

/**
 * Clear snooze for a routine
 */
export function clearSnooze(routineId: number): Routine | null {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);

  db.query("UPDATE routines SET snoozed_until = NULL, updated_at = ? WHERE id = ?").run(now, routineId);

  return getRoutineById(routineId);
}

/**
 * Check if a routine is currently snoozed
 */
export function isRoutineSnoozed(routine: Routine): boolean {
  const normalizedRoutine = normalizeRoutineSnoozeIfNeeded(routine);
  if (!normalizedRoutine.snoozed_until) {
    return false;
  }
  return normalizedRoutine.snoozed_until > Math.floor(Date.now() / 1000);
}

/**
 * Clear all expired snoozes from the database
 * Returns the routines that had their snooze cleared
 */
export function clearExpiredSnoozes(): Routine[] {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);

  // Back-compat cleanup: normalize any snoozed_until values that were accidentally stored in ms.
  // This prevents "stuck snoozed" routines that would otherwise take ~30k years to expire.
  const msSnoozes = db
    .query("SELECT * FROM routines WHERE snoozed_until IS NOT NULL AND snoozed_until > ?")
    .all(1_000_000_000_000) as Routine[];
  if (msSnoozes.length > 0) {
    for (const r of msSnoozes) {
      const normalized = normalizeEpochSeconds(r.snoozed_until);
      if (normalized !== null) {
        db.query("UPDATE routines SET snoozed_until = ?, updated_at = ? WHERE id = ?").run(normalized, now, r.id);
      }
    }
    logInfo("[Routines] Normalized", msSnoozes.length, "ms snooze(s) to seconds");
  }

  // Find routines with expired snoozes (snoozed_until is set but in the past)
  const expiredSnoozes = db
    .query("SELECT * FROM routines WHERE snoozed_until IS NOT NULL AND snoozed_until <= ? AND enabled = 1")
    .all(now) as Routine[];

  if (expiredSnoozes.length === 0) {
    logDebug("[Routines] No expired snoozes to clear");
    return [];
  }

  // Clear the expired snoozes
  db.query("UPDATE routines SET snoozed_until = NULL, updated_at = ? WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?")
    .run(now, now);

  logInfo("[Routines] Cleared expired snoozes for:", expiredSnoozes.map(r => r.name).join(", "));

  return expiredSnoozes;
}

// ============================================================================
// Pending Routines Detection
// ============================================================================

/**
 * Check if a routine is due based on its schedule type
 */
export function isRoutineDue(routine: Routine): boolean {
  // Check if disabled
  if (routine.enabled === 0) {
    return false;
  }

  // Check if snoozed
  if (isRoutineSnoozed(routine)) {
    return false;
  }

  // Check if already completed for this period
  if (isRoutineCompleted(routine)) {
    return false;
  }

  // Check specific_time - only due after the specified time
  const config = getRoutineScheduleConfig(routine);
  if (config.type === "specific_time") {
    const currentTime = getCurrentTime(routine.timezone ?? undefined);
    if (currentTime < config.time) {
      return false; // Not yet time
    }
  }

  return true;
}

/**
 * Get all pending (due) routines
 */
export function getPendingRoutines(): Routine[] {
  const enabledRoutines = getEnabledRoutines();
  return enabledRoutines.filter(isRoutineDue);
}

// ============================================================================
// Routine Status Information
// ============================================================================

export interface RoutineStatus {
  routine: Routine;
  isCompleted: boolean;
  isSnoozed: boolean;
  isDue: boolean;
  completionsToday: number;
  completionsThisWeek: number;
  snoozedUntilFormatted: string | null;
}

/**
 * Get status for all routines
 */
export function getAllRoutinesWithStatus(): RoutineStatus[] {
  const routines = getAllRoutines();

  return routines.map((routine) => {
    const todayCompletions = getTodayCompletions(routine.id, routine.timezone ?? undefined);
    const weekCompletions = getWeekCompletions(routine.id, routine.timezone ?? undefined);
    const normalizedRoutine = normalizeRoutineSnoozeIfNeeded(routine);
    const isSnoozed = isRoutineSnoozed(normalizedRoutine);

    return {
      routine: normalizedRoutine,
      isCompleted: isRoutineCompleted(normalizedRoutine),
      isSnoozed,
      isDue: isRoutineDue(normalizedRoutine),
      completionsToday: todayCompletions.length,
      completionsThisWeek: weekCompletions.length,
      snoozedUntilFormatted: isSnoozed && normalizedRoutine.snoozed_until
        ? new Date(normalizedRoutine.snoozed_until * 1000).toLocaleString()
        : null,
    };
  });
}

// ============================================================================
// Activity tracking
// ============================================================================

/**
 * Update last voice activity timestamp
 */
export function updateLastVoiceActivity(): void {
  setSetting("last_voice_activity", Date.now());
  logDebug("[Routines] Updated last voice activity");
}

/**
 * Get last voice activity timestamp
 */
export function getLastVoiceActivity(): number | null {
  return getSetting("last_voice_activity");
}

/**
 * Check if user was active in the last N milliseconds
 */
export function wasUserActiveRecently(withinMs: number = 60 * 60 * 1000): boolean {
  const lastActivity = getLastVoiceActivity();
  if (!lastActivity) {
    return false;
  }
  return Date.now() - lastActivity < withinMs;
}

function parseJsonField<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function getAgenticRoutineSpec(routine: Routine): AgenticRoutineSpec & { id: number; enabled: boolean } {
  return {
    id: routine.id,
    name: routine.name,
    description: routine.description ?? undefined,
    goal: routine.goal ?? routine.description ?? routine.name,
    triggers: parseJsonField<AgenticRoutineTrigger[]>(routine.triggers, [{ type: "schedule", schedule: getRoutineScheduleConfig(routine) }]),
    conditions: parseJsonField<AgenticRoutineCondition[]>(routine.conditions, []),
    contextRequests: parseJsonField(routine.context_requests, [{ type: "time" }]),
    actionGraph: parseJsonField(routine.action_graph, { actions: [{ type: "ask_ari", prompt: routine.description ?? routine.name }] }),
    permissions: parseJsonField(routine.permissions, { read: ["time"], notify: true, act: [], external: "ask" }),
    evaluation: parseJsonField(routine.evaluation, { askForFeedback: false, successSignals: [] }),
    delivery: parseJsonField(routine.delivery, { tts: "always", style: "ari", interruptibility: "normal" }),
    timezone: routine.timezone ?? undefined,
    enabled: routine.enabled === 1,
  };
}

export function recordRoutineRun(routineId: number, patchState?: Record<string, unknown>): Routine | null {
  const db = getDatabase();
  const routine = getRoutineById(routineId);
  if (!routine) return null;
  const now = Math.floor(Date.now() / 1000);
  const currentState = parseJsonField<Record<string, unknown>>(routine.routine_state, {});
  const runCount = typeof currentState.runCount === "number" ? currentState.runCount + 1 : 1;
  const nextState = { ...currentState, ...patchState, runCount, lastRunAt: now };
  db.query("UPDATE routines SET last_run_at = ?, routine_state = ?, updated_at = ? WHERE id = ?").run(
    now,
    JSON.stringify(nextState),
    now,
    routineId,
  );
  return getRoutineById(routineId);
}

