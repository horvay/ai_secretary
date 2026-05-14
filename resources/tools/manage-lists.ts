#!/usr/bin/env bun
/**
 * Manage Ari's Lists
 *
 * A CLI tool for managing named lists and their items.
 *
 * Usage:
 *   bun resources/tools/manage-lists.ts lists
 *   bun resources/tools/manage-lists.ts show --list "Shopping"
 *   bun resources/tools/manage-lists.ts create --name "Shopping"
 *   bun resources/tools/manage-lists.ts add --list "Shopping" --item "Milk"
 *   bun resources/tools/manage-lists.ts remove --list "Shopping" --id 1
 *   bun resources/tools/manage-lists.ts clear --list "Shopping"
 *   bun resources/tools/manage-lists.ts delete --list "Shopping"
 *   bun resources/tools/manage-lists.ts rename --list "Shopping" --name "Groceries"
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
 */
function findDbPath(): string {
  return join(getDataDir(), "memory", "memory.db");
}

const DB_PATH = findDbPath();

/**
 * Ensure the lists tables exist (creates them if missing)
 */
function ensureListsTables(db: Database): void {
  // Check if lists table exists
  const tableExists = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='lists'")
    .get();

  if (!tableExists) {
    // Create lists table
    db.exec(`
      CREATE TABLE IF NOT EXISTS lists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

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

    db.exec("CREATE INDEX IF NOT EXISTS idx_list_items_list_id ON list_items(list_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_list_items_position ON list_items(position)");
  }
}

function getDb(): Database {
  if (!existsSync(DB_PATH)) {
    console.log(`Error: Database not found at ${DB_PATH}`);
    console.log("The memory database has not been created yet. Start the AI Secretary app first.");
    process.exit(1);
  }
  const db = new Database(DB_PATH);
  db.exec("PRAGMA foreign_keys = ON");

  // Ensure lists tables exist
  ensureListsTables(db);

  return db;
}

// ============================================================================
// Helper Functions
// ============================================================================

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

interface List {
  id: number;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

interface ListItem {
  id: number;
  list_id: number;
  content: string;
  position: number;
  created_at: number;
}

// ============================================================================
// List Operations
// ============================================================================

function showAllLists(db: Database): void {
  const lists = db
    .query(
      `SELECT l.*,
        (SELECT COUNT(*) FROM list_items li WHERE li.list_id = l.id) AS item_count
       FROM lists l ORDER BY name ASC`
    )
    .all() as (List & { item_count: number })[];

  if (lists.length === 0) {
    console.log("No lists found. Use 'create' to make one.");
    return;
  }

  console.log(`\nFound ${lists.length} list(s):\n`);

  for (const list of lists) {
    console.log(`📋 ${list.name} (${list.item_count} item${list.item_count !== 1 ? "s" : ""})`);
    if (list.description) {
      console.log(`   ${list.description}`);
    }
  }

  console.log();
}

function showList(db: Database, args: Record<string, string>): void {
  const listName = args.list;

  if (!listName) {
    console.log("Error: --list is required");
    console.log("Usage: bun resources/tools/manage-lists.ts show --list \"Shopping\"");
    process.exit(1);
  }

  const list = db
    .query("SELECT * FROM lists WHERE LOWER(name) = LOWER(?)")
    .get(listName) as List | null;

  if (!list) {
    console.log(`Error: List "${listName}" not found`);
    process.exit(1);
  }

  const items = db
    .query("SELECT * FROM list_items WHERE list_id = ? ORDER BY position ASC")
    .all(list.id) as ListItem[];

  console.log(`\n📋 ${list.name}`);
  if (list.description) {
    console.log(`   ${list.description}`);
  }
  console.log();

  if (items.length === 0) {
    console.log("   (empty list)");
  } else {
    for (const item of items) {
      console.log(`   [${item.id}] ${item.content}`);
    }
  }

  console.log();
}

function createList(db: Database, args: Record<string, string>): void {
  const name = args.name;
  const description = args.description || null;

  if (!name) {
    console.log("Error: --name is required");
    console.log("Usage: bun resources/tools/manage-lists.ts create --name \"Shopping\"");
    process.exit(1);
  }

  // Check if list already exists
  const existing = db
    .query("SELECT id FROM lists WHERE LOWER(name) = LOWER(?)")
    .get(name);

  if (existing) {
    console.log(`Error: List "${name}" already exists`);
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);

  const result = db
    .query(
      `INSERT INTO lists (name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(name, description, now, now);

  console.log(`📋 Created list "${name}" with ID ${result.lastInsertRowid}`);
}

function addItem(db: Database, args: Record<string, string>): void {
  const listName = args.list;
  const content = args.item;

  if (!listName) {
    console.log("Error: --list is required");
    console.log("Usage: bun resources/tools/manage-lists.ts add --list \"Shopping\" --item \"Milk\"");
    process.exit(1);
  }

  if (!content) {
    console.log("Error: --item is required");
    console.log("Usage: bun resources/tools/manage-lists.ts add --list \"Shopping\" --item \"Milk\"");
    process.exit(1);
  }

  // Get or create the list
  let list = db
    .query("SELECT * FROM lists WHERE LOWER(name) = LOWER(?)")
    .get(listName) as List | null;

  const now = Math.floor(Date.now() / 1000);

  if (!list) {
    // Auto-create the list
    const result = db
      .query(
        `INSERT INTO lists (name, description, created_at, updated_at)
         VALUES (?, NULL, ?, ?)`
      )
      .run(listName, now, now);

    list = db.query("SELECT * FROM lists WHERE id = ?").get(result.lastInsertRowid) as List;
    console.log(`📋 Created new list "${listName}"`);
  }

  // Get the next position
  const maxPos = db
    .query("SELECT MAX(position) as max FROM list_items WHERE list_id = ?")
    .get(list.id) as { max: number | null };
  const position = (maxPos?.max ?? -1) + 1;

  db.query(
    `INSERT INTO list_items (list_id, content, position, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(list.id, content, position, now);

  // Update list's updated_at
  db.query("UPDATE lists SET updated_at = ? WHERE id = ?").run(now, list.id);

  console.log(`✅ Added "${content}" to ${list.name}`);
}

function removeItem(db: Database, args: Record<string, string>): void {
  const listName = args.list;
  const itemId = args.id ? parseInt(args.id, 10) : null;
  const itemContent = args.item;

  if (!listName) {
    console.log("Error: --list is required");
    console.log("Usage: bun resources/tools/manage-lists.ts remove --list \"Shopping\" --id 1");
    console.log("   or: bun resources/tools/manage-lists.ts remove --list \"Shopping\" --item \"Milk\"");
    process.exit(1);
  }

  if (!itemId && !itemContent) {
    console.log("Error: --id or --item is required");
    console.log("Usage: bun resources/tools/manage-lists.ts remove --list \"Shopping\" --id 1");
    console.log("   or: bun resources/tools/manage-lists.ts remove --list \"Shopping\" --item \"Milk\"");
    process.exit(1);
  }

  const list = db
    .query("SELECT * FROM lists WHERE LOWER(name) = LOWER(?)")
    .get(listName) as List | null;

  if (!list) {
    console.log(`Error: List "${listName}" not found`);
    process.exit(1);
  }

  let item: ListItem | null = null;

  if (itemId) {
    item = db
      .query("SELECT * FROM list_items WHERE id = ? AND list_id = ?")
      .get(itemId, list.id) as ListItem | null;

    if (!item) {
      console.log(`Error: Item with ID ${itemId} not found in list "${listName}"`);
      process.exit(1);
    }
  } else if (itemContent) {
    item = db
      .query("SELECT * FROM list_items WHERE list_id = ? AND LOWER(content) = LOWER(?) LIMIT 1")
      .get(list.id, itemContent) as ListItem | null;

    if (!item) {
      console.log(`Error: Item "${itemContent}" not found in list "${listName}"`);
      process.exit(1);
    }
  }

  if (item) {
    db.query("DELETE FROM list_items WHERE id = ?").run(item.id);

    const now = Math.floor(Date.now() / 1000);
    db.query("UPDATE lists SET updated_at = ? WHERE id = ?").run(now, list.id);

    console.log(`🗑️ Removed "${item.content}" from ${list.name}`);
  }
}

function clearList(db: Database, args: Record<string, string>): void {
  const listName = args.list;

  if (!listName) {
    console.log("Error: --list is required");
    console.log("Usage: bun resources/tools/manage-lists.ts clear --list \"Shopping\"");
    process.exit(1);
  }

  const list = db
    .query("SELECT * FROM lists WHERE LOWER(name) = LOWER(?)")
    .get(listName) as List | null;

  if (!list) {
    console.log(`Error: List "${listName}" not found`);
    process.exit(1);
  }

  const result = db.query("DELETE FROM list_items WHERE list_id = ?").run(list.id);

  const now = Math.floor(Date.now() / 1000);
  db.query("UPDATE lists SET updated_at = ? WHERE id = ?").run(now, list.id);

  console.log(`🧹 Cleared ${result.changes} item(s) from ${list.name}`);
}

function deleteList(db: Database, args: Record<string, string>): void {
  const listName = args.list;

  if (!listName) {
    console.log("Error: --list is required");
    console.log("Usage: bun resources/tools/manage-lists.ts delete --list \"Shopping\"");
    process.exit(1);
  }

  const list = db
    .query("SELECT * FROM lists WHERE LOWER(name) = LOWER(?)")
    .get(listName) as List | null;

  if (!list) {
    console.log(`Error: List "${listName}" not found`);
    process.exit(1);
  }

  db.query("DELETE FROM lists WHERE id = ?").run(list.id);

  console.log(`🗑️ Deleted list "${list.name}" and all its items`);
}

function renameList(db: Database, args: Record<string, string>): void {
  const listName = args.list;
  const newName = args.name;

  if (!listName) {
    console.log("Error: --list is required");
    console.log("Usage: bun resources/tools/manage-lists.ts rename --list \"Shopping\" --name \"Groceries\"");
    process.exit(1);
  }

  if (!newName) {
    console.log("Error: --name is required");
    console.log("Usage: bun resources/tools/manage-lists.ts rename --list \"Shopping\" --name \"Groceries\"");
    process.exit(1);
  }

  const list = db
    .query("SELECT * FROM lists WHERE LOWER(name) = LOWER(?)")
    .get(listName) as List | null;

  if (!list) {
    console.log(`Error: List "${listName}" not found`);
    process.exit(1);
  }

  // Check if new name already exists
  const existing = db
    .query("SELECT id FROM lists WHERE LOWER(name) = LOWER(?) AND id != ?")
    .get(newName, list.id);

  if (existing) {
    console.log(`Error: A list named "${newName}" already exists`);
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  db.query("UPDATE lists SET name = ?, updated_at = ? WHERE id = ?").run(newName, now, list.id);

  console.log(`✏️ Renamed "${list.name}" to "${newName}"`);
}

// ============================================================================
// Help & Main
// ============================================================================

function printUsage(): void {
  console.log(`
Manage Ari's Lists

Usage:
  bun resources/tools/manage-lists.ts <command> [options]

Commands:
  lists                   List all lists with item counts
  show                    Show items in a specific list
  create                  Create a new named list
  add                     Add an item to a list (creates list if needed)
  remove                  Remove an item from a list
  clear                   Remove all items from a list
  delete                  Delete an entire list
  rename                  Rename a list

Options for 'show', 'add', 'remove', 'clear', 'delete', 'rename':
  --list <name>           List name (required)

Options for 'create':
  --name <name>           List name (required)
  --description <desc>    Optional description

Options for 'add':
  --item <content>        Item to add (required)

Options for 'remove':
  --id <id>               Item ID to remove
  --item <content>        Or item content to remove (first match)

Options for 'rename':
  --name <name>           New name for the list

Examples:
  # Show all lists
  bun resources/tools/manage-lists.ts lists

  # Create a shopping list
  bun resources/tools/manage-lists.ts create --name "Shopping"

  # Add items to shopping list (auto-creates if needed)
  bun resources/tools/manage-lists.ts add --list "Shopping" --item "Milk"
  bun resources/tools/manage-lists.ts add --list "Shopping" --item "Eggs"
  bun resources/tools/manage-lists.ts add --list "Shopping" --item "Bread"

  # Show shopping list
  bun resources/tools/manage-lists.ts show --list "Shopping"

  # Remove an item by ID
  bun resources/tools/manage-lists.ts remove --list "Shopping" --id 2

  # Remove an item by content
  bun resources/tools/manage-lists.ts remove --list "Shopping" --item "Milk"

  # Clear all items from a list
  bun resources/tools/manage-lists.ts clear --list "Shopping"

  # Rename a list
  bun resources/tools/manage-lists.ts rename --list "Shopping" --name "Groceries"

  # Delete a list entirely
  bun resources/tools/manage-lists.ts delete --list "Shopping"
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
      case "lists":
        showAllLists(db);
        break;
      case "show":
        showList(db, args);
        break;
      case "create":
        createList(db, args);
        break;
      case "add":
        addItem(db, args);
        break;
      case "remove":
        removeItem(db, args);
        break;
      case "clear":
        clearList(db, args);
        break;
      case "delete":
        deleteList(db, args);
        break;
      case "rename":
        renameList(db, args);
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
