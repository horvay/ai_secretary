#!/usr/bin/env bun

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function printUsage() {
  console.log(`
Playwright MCP helper

Usage:
  bun scripts/playwright-mcp.ts list-tools
  bun scripts/playwright-mcp.ts call <toolName> [jsonArgs]
  bun scripts/playwright-mcp.ts demo [url]

Examples:
  bun scripts/playwright-mcp.ts list-tools
  bun scripts/playwright-mcp.ts call browser_tabs '{"action":"new","url":"https://example.com"}'
  bun scripts/playwright-mcp.ts call browser_snapshot '{}'
  bun scripts/playwright-mcp.ts demo https://example.com
`);
}

async function withClient<T>(fn: (client: Client) => Promise<T>) {
  const client = new Client(
    { name: "ai-secretary-playwright-mcp-helper", version: "0.1.0" },
    { capabilities: {} },
  );

  const transport = new StdioClientTransport({
    command: "bunx",
    args: ["@playwright/mcp@latest", "--browser", "chromium", "--isolated"],
    stderr: "pipe",
  });

  const stderr = transport.stderr as { on?: (event: string, handler: (chunk: Buffer | string) => void) => void } | undefined;
  if (stderr?.on) {
    stderr.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (text.trim()) {
        console.error(text);
      }
    });
  }

  await client.connect(transport);

  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function listTools() {
  return withClient(async (client) => {
    const result = await client.listTools();
    for (const tool of result.tools) {
      console.log(`- ${tool.name}${tool.description ? ` — ${tool.description}` : ""}`);
    }
  });
}

async function callTool(toolName: string, jsonArgs?: string) {
  let args: Record<string, unknown> = {};
  if (jsonArgs && jsonArgs.trim().length > 0) {
    args = JSON.parse(jsonArgs);
  }

  return withClient(async (client) => {
    const result = await client.callTool({
      name: toolName,
      arguments: args,
    });

    console.log(JSON.stringify(result, null, 2));
  });
}

async function demo(url = "https://example.com") {
  return withClient(async (client) => {
    console.log(`Opening new tab at ${url}...`);
    await client.callTool({
      name: "browser_tabs",
      arguments: { action: "new", url },
    });

    console.log("Waiting for page to settle...");
    await client.callTool({
      name: "browser_wait_for",
      arguments: { time: 2 },
    });

    console.log("Snapshot:");
    const snapshot = await client.callTool({
      name: "browser_snapshot",
      arguments: {},
    });
    console.log(JSON.stringify(snapshot, null, 2));
  });
}

const [command, ...rest] = Bun.argv.slice(2);

if (!command || command === "--help" || command === "-h") {
  printUsage();
  process.exit(0);
}

try {
  if (command === "list-tools") {
    await listTools();
  } else if (command === "call") {
    const [toolName, jsonArgs] = rest;
    if (!toolName) {
      throw new Error("Missing tool name for call command");
    }
    await callTool(toolName, jsonArgs);
  } else if (command === "demo") {
    await demo(rest[0]);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}
