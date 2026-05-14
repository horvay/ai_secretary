/**
 * Tasks Service for Ari
 * First-class user action items. Tasks are distinct from one-time reminders,
 * recurring routines, and lightweight list items.
 */

import { getDatabase, type Task } from "../db";
import { logInfo } from "../utils/logger";

export function createTask(params: {
  title: string;
  description?: string;
  priority?: "low" | "normal" | "high";
  dueAt?: number;
  reminderAt?: number;
  listId?: number;
  metadata?: Record<string, unknown>;
}): Task {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);

  const result = db
    .query(
      `INSERT INTO tasks (title, description, status, priority, due_at, reminder_at, list_id, created_at, updated_at, metadata)
       VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.title,
      params.description ?? null,
      params.priority ?? "normal",
      params.dueAt ?? null,
      params.reminderAt ?? null,
      params.listId ?? null,
      now,
      now,
      params.metadata ? JSON.stringify(params.metadata) : null,
    );

  const task = getTaskById(Number(result.lastInsertRowid))!;
  logInfo("[Tasks] Created task:", task.title, "id:", task.id);
  return task;
}

export function getTaskById(id: number): Task | null {
  const db = getDatabase();
  return db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Task | null;
}

export function getAllTasks(options?: { status?: Task["status"]; limit?: number }): Task[] {
  const db = getDatabase();
  const params: (string | number)[] = [];
  let sql = "SELECT * FROM tasks WHERE 1=1";

  if (options?.status) {
    sql += " AND status = ?";
    params.push(options.status);
  }

  sql += " ORDER BY COALESCE(due_at, 9999999999) ASC, created_at DESC";

  if (options?.limit) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }

  return db.query(sql).all(...params) as Task[];
}

export function updateTask(
  id: number,
  params: {
    title?: string;
    description?: string | null;
    priority?: "low" | "normal" | "high" | null;
    dueAt?: number | null;
    reminderAt?: number | null;
    listId?: number | null;
    metadata?: Record<string, unknown> | null;
  },
): Task | null {
  const existing = getTaskById(id);
  if (!existing) return null;

  const db = getDatabase();
  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (params.title !== undefined) {
    updates.push("title = ?");
    values.push(params.title);
  }
  if (params.description !== undefined) {
    updates.push("description = ?");
    values.push(params.description);
  }
  if (params.priority !== undefined) {
    updates.push("priority = ?");
    values.push(params.priority);
  }
  if (params.dueAt !== undefined) {
    updates.push("due_at = ?");
    values.push(params.dueAt);
  }
  if (params.reminderAt !== undefined) {
    updates.push("reminder_at = ?");
    values.push(params.reminderAt);
  }
  if (params.listId !== undefined) {
    updates.push("list_id = ?");
    values.push(params.listId);
  }
  if (params.metadata !== undefined) {
    updates.push("metadata = ?");
    values.push(params.metadata ? JSON.stringify(params.metadata) : null);
  }

  if (updates.length === 0) return existing;

  updates.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000), id);

  db.query(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`).run(...values);
  return getTaskById(id);
}

export function completeTask(id: number): Task | null {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);
  db.query("UPDATE tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
  return getTaskById(id);
}

export function cancelTask(id: number): Task | null {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);
  db.query("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, id);
  return getTaskById(id);
}

export function deleteTask(id: number): boolean {
  const db = getDatabase();
  const result = db.query("DELETE FROM tasks WHERE id = ?").run(id);
  if (result.changes > 0) {
    logInfo("[Tasks] Deleted task:", id);
    return true;
  }
  return false;
}
