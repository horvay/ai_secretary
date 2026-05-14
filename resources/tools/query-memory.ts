#!/usr/bin/env bun
/**
 * Query Ari's Memory Database
 *
 * A SQL CLI tool for querying Ari's memory database.
 * Automatically adds LIMIT 20 and appropriate ORDER BY clause.
 *
 * Usage:
 *   bun resources/tools/query-memory.ts "SELECT * FROM interactions WHERE content LIKE '%keyword%'"
 *   bun resources/tools/query-memory.ts "SELECT * FROM daily_summaries WHERE date >= '2024-01-01'"
 *
 * Available Tables:
 *   - interactions: Conversation history
 *     Columns: id, type, role, content, session_id, timestamp, metadata
 *
 *   - daily_summaries: End-of-day summaries
 *     Columns: id, date, summary, interaction_count, created_at, updated_at
 *
 *   - screenshots: Screenshot metadata
 *     Columns: id, file_key, ocr_text, timestamp, width, height, metadata
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

/**
 * Find the memory database path
 */
function findDbPath(): string {
  return join(getDataDir(), "memory", "memory.db");
}

// Database path
const DB_PATH = findDbPath();

/**
 * Format a timestamp to a human-readable date string
 */
function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

/**
 * Detect which table is being queried
 */
function detectTable(query: string): "interactions" | "daily_summaries" | "screenshots" | null {
  const lowerQuery = query.toLowerCase();
  if (lowerQuery.includes("from interactions") || lowerQuery.includes("from `interactions`")) {
    return "interactions";
  }
  if (lowerQuery.includes("from daily_summaries") || lowerQuery.includes("from `daily_summaries`")) {
    return "daily_summaries";
  }
  if (lowerQuery.includes("from screenshots") || lowerQuery.includes("from `screenshots`")) {
    return "screenshots";
  }
  return null;
}

/**
 * Check if query already has ORDER BY clause
 */
function hasOrderBy(query: string): boolean {
  return /order\s+by/i.test(query);
}

/**
 * Check if query already has LIMIT clause
 */
function hasLimit(query: string): boolean {
  return /\blimit\s+\d+/i.test(query);
}

/**
 * Enhance query with automatic ORDER BY and LIMIT
 */
function enhanceQuery(query: string): string {
  let enhancedQuery = query.trim();

  // Remove trailing semicolon if present (we'll add it back)
  if (enhancedQuery.endsWith(";")) {
    enhancedQuery = enhancedQuery.slice(0, -1);
  }

  const table = detectTable(query);

  // Add ORDER BY if not present
  if (!hasOrderBy(enhancedQuery)) {
    if (table === "interactions" || table === "screenshots") {
      enhancedQuery += " ORDER BY timestamp DESC";
    } else if (table === "daily_summaries") {
      enhancedQuery += " ORDER BY date DESC";
    }
  }

  // Add LIMIT if not present
  if (!hasLimit(enhancedQuery)) {
    enhancedQuery += " LIMIT 20";
  }

  return enhancedQuery;
}

/**
 * Format results for display
 */
function formatResults(results: unknown[], table: string | null): string {
  if (results.length === 0) {
    return "No results found.";
  }

  const output: string[] = [];
  output.push(`Found ${results.length} result(s):\n`);

  for (const row of results) {
    const record = row as Record<string, unknown>;
    output.push("---");

    for (const [key, value] of Object.entries(record)) {
      // Format timestamps nicely
      if (key === "timestamp" && typeof value === "number") {
        output.push(`${key}: ${formatTimestamp(value)} (${value})`);
      } else if (key === "content" && typeof value === "string") {
        // Truncate long content
        const content = value.length > 500 ? value.substring(0, 500) + "..." : value;
        output.push(`${key}: ${content}`);
      } else if (key === "metadata" && typeof value === "string") {
        try {
          const parsed = JSON.parse(value);
          output.push(`${key}: ${JSON.stringify(parsed, null, 2)}`);
        } catch {
          output.push(`${key}: ${value}`);
        }
      } else {
        output.push(`${key}: ${value}`);
      }
    }
  }

  return output.join("\n");
}

/**
 * Print usage information
 */
function printUsage(): void {
  console.log(`
Query Ari's Memory Database

Usage:
  bun resources/tools/query-memory.ts "<SQL query>"

The tool automatically adds:
  - LIMIT 20 (if not specified)
  - ORDER BY timestamp DESC (for interactions/screenshots)
  - ORDER BY date DESC (for daily_summaries)

Available Tables:

  interactions - Conversation history
    Columns: id, type, role, content, session_id, timestamp, metadata

  daily_summaries - End-of-day summaries
    Columns: id, date, summary, interaction_count, created_at, updated_at

  screenshots - Screenshot metadata
    Columns: id, file_key, ocr_text, timestamp, width, height, metadata

Example Queries:

  # Search for keyword in conversations
  bun resources/tools/query-memory.ts "SELECT * FROM interactions WHERE content LIKE '%keyword%'"

  # Get user messages only
  bun resources/tools/query-memory.ts "SELECT * FROM interactions WHERE role = 'user'"

  # Get recent daily summaries
  bun resources/tools/query-memory.ts "SELECT * FROM daily_summaries"

  # Search for text in specific date range
  bun resources/tools/query-memory.ts "SELECT * FROM interactions WHERE timestamp > 1704067200000"

  # Count interactions
  bun resources/tools/query-memory.ts "SELECT COUNT(*) as count FROM interactions"
`);
}

/**
 * Main function
 */
async function main(): Promise<void> {
  const query = process.argv[2];

  // Show help if no query provided
  if (!query || query === "--help" || query === "-h") {
    printUsage();
    process.exit(query ? 0 : 1);
  }

  // Check if database exists
  if (!existsSync(DB_PATH)) {
    console.log(`Error: Database not found at ${DB_PATH}`);
    console.log("The memory database has not been created yet. Start the AI Secretary app first.");
    process.exit(1);
  }

  // Validate query is a SELECT statement (read-only)
  const trimmedQuery = query.trim().toLowerCase();
  if (!trimmedQuery.startsWith("select")) {
    console.log("Error: Only SELECT queries are allowed for safety.");
    console.log("This tool is read-only to protect your memory data.");
    process.exit(1);
  }

  try {
    // Open database in read-only mode
    const db = new Database(DB_PATH, { readonly: true });

    // Enhance query with ORDER BY and LIMIT
    const enhancedQuery = enhanceQuery(query);
    const table = detectTable(query);

    console.log(`Executing query: ${enhancedQuery}\n`);

    // Execute query
    const results = db.query(enhancedQuery).all();

    // Format and display results
    console.log(formatResults(results, table));

    // Close database
    db.close();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.log(`Error executing query: ${errorMessage}`);

    // Provide helpful hints for common errors
    if (errorMessage.includes("no such table")) {
      console.log("\nHint: Available tables are: interactions, daily_summaries, screenshots");
    } else if (errorMessage.includes("no such column")) {
      console.log("\nHint: Check column names. Use --help to see available columns.");
    }

    process.exit(1);
  }
}

main();

