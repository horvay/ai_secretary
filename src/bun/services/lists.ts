/**
 * Lists Service for Ari
 * Manages named lists with simple item add/remove operations
 */

import { getDatabase, type List, type ListItem } from "../db";
import { logInfo, logDebug, logWarn } from "../utils/logger";

// ============================================================================
// List CRUD Operations
// ============================================================================

/**
 * Create a new named list
 */
export function createList(params: { name: string; description?: string }): List {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);

  const result = db
    .query(
      `INSERT INTO lists (name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(params.name, params.description ?? null, now, now);

  const list = getListById(Number(result.lastInsertRowid))!;
  logInfo("[Lists] Created list:", list.name, "id:", list.id);
  return list;
}

/**
 * Get a list by ID
 */
export function getListById(id: number): List | null {
  const db = getDatabase();
  return db.query("SELECT * FROM lists WHERE id = ?").get(id) as List | null;
}

/**
 * Get a list by name (case-insensitive)
 */
export function getListByName(name: string): List | null {
  const db = getDatabase();
  return db
    .query("SELECT * FROM lists WHERE LOWER(name) = LOWER(?)")
    .get(name) as List | null;
}

/**
 * Get all lists
 */
export function getAllLists(): List[] {
  const db = getDatabase();
  return db.query("SELECT * FROM lists ORDER BY name ASC").all() as List[];
}

/**
 * Get all lists with item counts
 */
export function getAllListsWithCounts(): (List & { item_count: number })[] {
  const db = getDatabase();
  return db
    .query(
      `SELECT l.*,
        (SELECT COUNT(*) FROM list_items li WHERE li.list_id = l.id) AS item_count
       FROM lists l ORDER BY name ASC`
    )
    .all() as (List & { item_count: number })[];
}

/**
 * Update a list
 */
export function updateList(
  id: number,
  params: { name?: string; description?: string }
): List | null {
  const db = getDatabase();
  const existing = getListById(id);
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

  if (updates.length === 0) {
    return existing;
  }

  updates.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);

  db.query(`UPDATE lists SET ${updates.join(", ")} WHERE id = ?`).run(...values);

  logDebug("[Lists] Updated list:", id);
  return getListById(id);
}

/**
 * Rename a list
 */
export function renameList(id: number, newName: string): List | null {
  return updateList(id, { name: newName });
}

/**
 * Delete a list and all its items (CASCADE)
 */
export function deleteList(id: number): boolean {
  const db = getDatabase();
  const result = db.query("DELETE FROM lists WHERE id = ?").run(id);
  if (result.changes > 0) {
    logInfo("[Lists] Deleted list:", id);
    return true;
  }
  return false;
}

/**
 * Delete a list by name
 */
export function deleteListByName(name: string): boolean {
  const list = getListByName(name);
  if (!list) {
    return false;
  }
  return deleteList(list.id);
}

// ============================================================================
// List Item Operations
// ============================================================================

/**
 * Add an item to a list
 */
export function addItem(listId: number, content: string): ListItem | null {
  const db = getDatabase();
  const list = getListById(listId);

  if (!list) {
    logWarn("[Lists] Cannot add item to non-existent list:", listId);
    return null;
  }

  // Get the next position
  const maxPos = db
    .query("SELECT MAX(position) as max FROM list_items WHERE list_id = ?")
    .get(listId) as { max: number | null };
  const position = (maxPos?.max ?? -1) + 1;

  const now = Math.floor(Date.now() / 1000);

  const result = db
    .query(
      `INSERT INTO list_items (list_id, content, position, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(listId, content, position, now);

  // Update list's updated_at
  db.query("UPDATE lists SET updated_at = ? WHERE id = ?").run(now, listId);

  logInfo("[Lists] Added item to", list.name, ":", content);

  return {
    id: Number(result.lastInsertRowid),
    list_id: listId,
    content,
    position,
    created_at: now,
  };
}

/**
 * Add an item to a list by list name (creates list if it doesn't exist)
 */
export function addItemByListName(
  listName: string,
  content: string
): { list: List; item: ListItem } {
  let list = getListByName(listName);

  if (!list) {
    // Auto-create the list
    list = createList({ name: listName });
  }

  const item = addItem(list.id, content)!;
  return { list, item };
}

/**
 * Get an item by ID
 */
export function getItemById(id: number): ListItem | null {
  const db = getDatabase();
  return db.query("SELECT * FROM list_items WHERE id = ?").get(id) as ListItem | null;
}

/**
 * Get all items in a list
 */
export function getListItems(listId: number): ListItem[] {
  const db = getDatabase();
  return db
    .query("SELECT * FROM list_items WHERE list_id = ? ORDER BY position ASC")
    .all(listId) as ListItem[];
}

/**
 * Get all items in a list by list name
 */
export function getListItemsByName(listName: string): ListItem[] {
  const list = getListByName(listName);
  if (!list) {
    return [];
  }
  return getListItems(list.id);
}

/**
 * Remove an item by ID
 */
export function removeItem(itemId: number): boolean {
  const db = getDatabase();
  const item = getItemById(itemId);

  if (!item) {
    return false;
  }

  const result = db.query("DELETE FROM list_items WHERE id = ?").run(itemId);

  if (result.changes > 0) {
    // Update list's updated_at
    const now = Math.floor(Date.now() / 1000);
    db.query("UPDATE lists SET updated_at = ? WHERE id = ?").run(now, item.list_id);
    logInfo("[Lists] Removed item:", itemId);
    return true;
  }
  return false;
}

/**
 * Remove an item by content from a list (removes first match)
 */
export function removeItemByContent(listId: number, content: string): boolean {
  const db = getDatabase();

  // Find the first matching item
  const item = db
    .query("SELECT id FROM list_items WHERE list_id = ? AND LOWER(content) = LOWER(?) LIMIT 1")
    .get(listId, content) as { id: number } | null;

  if (!item) {
    return false;
  }

  return removeItem(item.id);
}

/**
 * Remove an item by content from a list by list name
 */
export function removeItemByContentAndListName(listName: string, content: string): boolean {
  const list = getListByName(listName);
  if (!list) {
    return false;
  }
  return removeItemByContent(list.id, content);
}

/**
 * Clear all items from a list
 */
export function clearList(listId: number): number {
  const db = getDatabase();
  const result = db.query("DELETE FROM list_items WHERE list_id = ?").run(listId);

  if (result.changes > 0) {
    const now = Math.floor(Date.now() / 1000);
    db.query("UPDATE lists SET updated_at = ? WHERE id = ?").run(now, listId);
    logInfo("[Lists] Cleared", result.changes, "items from list:", listId);
  }

  return result.changes;
}

/**
 * Clear all items from a list by name
 */
export function clearListByName(listName: string): number {
  const list = getListByName(listName);
  if (!list) {
    return 0;
  }
  return clearList(list.id);
}

/**
 * Get item count for a list
 */
export function getItemCount(listId: number): number {
  const db = getDatabase();
  const result = db
    .query("SELECT COUNT(*) as count FROM list_items WHERE list_id = ?")
    .get(listId) as { count: number };
  return result.count;
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Get a list with its items
 */
export function getListWithItems(
  listId: number
): { list: List; items: ListItem[] } | null {
  const list = getListById(listId);
  if (!list) {
    return null;
  }

  const items = getListItems(listId);
  return { list, items };
}

/**
 * Get a list with its items by name
 */
export function getListWithItemsByName(
  listName: string
): { list: List; items: ListItem[] } | null {
  const list = getListByName(listName);
  if (!list) {
    return null;
  }

  const items = getListItems(list.id);
  return { list, items };
}

/**
 * Check if a list exists
 */
export function listExists(name: string): boolean {
  return getListByName(name) !== null;
}

/**
 * Get or create a list by name
 */
export function getOrCreateList(name: string, description?: string): List {
  const existing = getListByName(name);
  if (existing) {
    return existing;
  }
  return createList({ name, description });
}
