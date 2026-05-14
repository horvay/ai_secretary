#!/usr/bin/env bun
/**
 * Memory Query Script
 * Query Ari's memory database using the memory service functions
 *
 * Usage:
 *   bun scripts/query-memory.ts search "your query"
 *   bun scripts/query-memory.ts stats
 *   bun scripts/query-memory.ts recent [limit]
 *   bun scripts/query-memory.ts today
 */

import { initMemory, getInteractions, getMemoryStats, searchInteractions } from "../src/bun/services/memory";
import { getRecentDailySummaries } from "../src/bun/services/memory";
import { searchInteractions as searchMemoryIndex } from "../src/bun/services/memory-index";

async function main() {
  // Initialize memory system
  await initMemory();

  const command = process.argv[2];
  const args = process.argv.slice(3);

  switch (command) {
    case "search": {
      const query = args.join(" ");
      if (!query) {
        console.error("Usage: bun scripts/query-memory.ts search \"your query\"");
        process.exit(1);
      }
      console.log(`🔍 Searching for: "${query}"\n`);
      const results = searchMemoryIndex(query, { limit: 10 });
      if (results.length === 0) {
        console.log("No results found.");
      } else {
        results.forEach((result, i) => {
          const date = new Date(result.interaction.timestamp).toLocaleString();
          console.log(`${i + 1}. [${result.interaction.role}] ${date}`);
          console.log(`   ${result.snippet}`);
          console.log();
        });
      }
      break;
    }

    case "recent": {
      const limit = args[0] ? parseInt(args[0], 10) : 10;
      console.log(`📜 Recent ${limit} interactions:\n`);
      const interactions = getInteractions({ limit, offset: 0 });
      interactions.forEach((interaction, i) => {
        const date = new Date(interaction.timestamp).toLocaleString();
        const preview = interaction.content.substring(0, 100);
        console.log(`${i + 1}. [${interaction.role}] ${date}`);
        console.log(`   ${preview}${interaction.content.length > 100 ? "..." : ""}`);
        console.log();
      });
      break;
    }

    case "today": {
      console.log("📅 Today's interactions:\n");
      const interactions = getInteractions({
        startTime: new Date().setHours(0, 0, 0, 0),
      });
      if (interactions.length === 0) {
        console.log("No interactions today.");
      } else {
        interactions.forEach((interaction, i) => {
          const time = new Date(interaction.timestamp).toLocaleTimeString();
          const preview = interaction.content.substring(0, 80);
          console.log(`${i + 1}. [${interaction.role}] ${time}`);
          console.log(`   ${preview}${interaction.content.length > 80 ? "..." : ""}`);
          console.log();
        });
      }
      break;
    }

    case "stats": {
      console.log("📊 Memory Statistics:\n");
      const stats = getMemoryStats();
      console.log(`Total Interactions: ${stats.totalInteractions}`);
      console.log(`Today's Interactions: ${stats.todayInteractions}`);
      console.log(`Total Screenshots: ${stats.totalScreenshots}`);
      console.log(`Total Daily Summaries: ${stats.totalDailySummaries}`);
      if (stats.oldestInteraction) {
        console.log(`Oldest: ${new Date(stats.oldestInteraction).toLocaleString()}`);
      }
      if (stats.newestInteraction) {
        console.log(`Newest: ${new Date(stats.newestInteraction).toLocaleString()}`);
      }
      break;
    }

    case "summaries": {
      console.log("📝 Daily Summaries:\n");
      const summaries = getRecentDailySummaries(10);
      if (summaries.length === 0) {
        console.log("No daily summaries yet.");
      } else {
        summaries.forEach((summary) => {
          console.log(`${summary.date}:`);
          console.log(`  ${summary.summary.substring(0, 150)}${summary.summary.length > 150 ? "..." : ""}`);
          console.log(`  (${summary.interaction_count} interactions)`);
          console.log();
        });
      }
      break;
    }

    case "help":
    case "--help":
    case "-h": {
      console.log(`
Memory Query Tool

Usage:
  bun scripts/query-memory.ts <command> [args]

Commands:
  search "query"     - Search interactions by text
  recent [limit]    - Show recent interactions (default: 10)
  today             - Show today's interactions
  stats             - Show memory statistics
  summaries         - Show recent daily summaries
  help              - Show this help message

Examples:
  bun scripts/query-memory.ts search "remember"
  bun scripts/query-memory.ts recent 20
  bun scripts/query-memory.ts today
  bun scripts/query-memory.ts stats
`);
      break;
    }

    default: {
      console.error(`Unknown command: ${command}`);
      console.error("Run 'bun scripts/query-memory.ts help' for usage");
      process.exit(1);
    }
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});

