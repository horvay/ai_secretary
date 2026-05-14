/**
 * Reminders Service for Ari
 * Manages one-time alerts with CRUD operations
 */

import { getDatabase, type Reminder, type ReminderStatus } from "../db";
import { filterDueReminders } from "./scheduler/reminder-engine";
import { logInfo } from "../utils/logger";

// ============================================================================
// Reminder CRUD Operations
// ============================================================================

/**
 * Create a new one-time reminder
 */
export function createReminder(params: {
  content: string;
  dueAt: number; // Unix timestamp in seconds
}): Reminder {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);

  const result = db
    .query(
      `INSERT INTO reminders (content, due_at, status, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?)`
    )
    .run(params.content, params.dueAt, now, now);

  const reminder = getReminderById(Number(result.lastInsertRowid))!;
  logInfo("[Reminders] Created reminder:", reminder.content, "due at:", new Date(reminder.due_at * 1000).toLocaleString());
  return reminder;
}

/**
 * Get a reminder by ID
 */
export function getReminderById(id: number): Reminder | null {
  const db = getDatabase();
  return db.query("SELECT * FROM reminders WHERE id = ?").get(id) as Reminder | null;
}

/**
 * Get all reminders
 */
export function getAllReminders(): Reminder[] {
  const db = getDatabase();
  return db.query("SELECT * FROM reminders ORDER BY due_at ASC").all() as Reminder[];
}

/**
 * Get pending reminders that are due now or in the past
 */
export function getPendingDueReminders(): Reminder[] {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);
  const rows = db.query("SELECT * FROM reminders ORDER BY due_at ASC").all() as Reminder[];
  return filterDueReminders(rows, now) as Reminder[];
}

/**
 * Mark a reminder as triggered/delivered to the frontend. This deliberately does
 * not complete it; completion/ack is a separate lifecycle step so due reminders
 * are not silently lost if UI/TTS delivery fails.
 */
export function markReminderTriggered(id: number): Reminder | null {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);

  db.query(
    `UPDATE reminders
     SET status = 'triggered', triggered_at = ?, trigger_count = COALESCE(trigger_count, 0) + 1, updated_at = ?
     WHERE id = ?`
  ).run(now, now, id);

  const reminder = getReminderById(id);
  if (reminder) {
    logInfo("[Reminders] Marked reminder as triggered:", reminder.content);
  }
  return reminder;
}

/**
 * Acknowledge a triggered reminder and mark it completed.
 */
export function acknowledgeReminder(id: number): Reminder | null {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);

  db.query(
    "UPDATE reminders SET status = 'completed', delivered_at = COALESCE(delivered_at, ?), acknowledged_at = ?, updated_at = ? WHERE id = ?"
  ).run(now, now, now, id);

  const reminder = getReminderById(id);
  if (reminder) {
    logInfo("[Reminders] Acknowledged reminder:", reminder.content);
  }
  return reminder;
}

/**
 * Mark a reminder as completed
 */
export function markReminderCompleted(id: number): Reminder | null {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);

  db.query("UPDATE reminders SET status = 'completed', updated_at = ? WHERE id = ?").run(now, id);

  const reminder = getReminderById(id);
  if (reminder) {
    logInfo("[Reminders] Marked reminder as completed:", reminder.content);
  }
  return reminder;
}

/**
 * Cancel a reminder
 */
export function cancelReminder(id: number): Reminder | null {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);

  db.query("UPDATE reminders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, id);

  const reminder = getReminderById(id);
  if (reminder) {
    logInfo("[Reminders] Cancelled reminder:", reminder.content);
  }
  return reminder;
}

/**
 * Delete a reminder permanently
 */
export function deleteReminder(id: number): boolean {
  const db = getDatabase();
  const result = db.query("DELETE FROM reminders WHERE id = ?").run(id);
  if (result.changes > 0) {
    logInfo("[Reminders] Deleted reminder record:", id);
    return true;
  }
  return false;
}
