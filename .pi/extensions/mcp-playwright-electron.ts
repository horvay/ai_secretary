import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "path";

type McpClientState = {
  client: Client;
  transport: StdioClientTransport;
};

let state: McpClientState | undefined;
let connectPromise: Promise<Client> | undefined;

const projectRoot = path.resolve(process.env.AI_SECRETARY_PROJECT_ROOT ?? path.dirname(fileURLToPath(import.meta.url)), process.env.AI_SECRETARY_PROJECT_ROOT ? "." : "../..");

const getElectronMcpEnv = () => {
  const env = getDefaultEnvironment();
  for (const key of [
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "XAUTHORITY",
    "XDG_SESSION_TYPE",
    "GDK_BACKEND",
    "QT_QPA_PLATFORM",
    "ELECTRON_OZONE_PLATFORM_HINT",
  ]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }

  env.AI_SECRETARY_PROJECT_ROOT = projectRoot;
  env.AI_SECRETARY_ROOT = projectRoot;
  return env;
};

const connect = async () => {
  if (state) return state.client;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    const client = new Client(
      { name: "ai-secretary-electron-mcp-bridge", version: "0.1.0" },
      { capabilities: {} },
    );
    const transport = new StdioClientTransport({
      command: "/usr/bin/bun",
      args: [path.join(projectRoot, "tools", "mcp-playwright-electron.ts")],
      env: getElectronMcpEnv(),
      stderr: "inherit",
    });

    await client.connect(transport);
    state = { client, transport };
    connectPromise = undefined;
    return client;
  })().catch((error) => {
    connectPromise = undefined;
    state = undefined;
    throw error;
  });

  return connectPromise;
};

const disconnect = async () => {
  const current = state;
  state = undefined;
  connectPromise = undefined;
  if (!current) return;
  try {
    await current.client.callTool({ name: "electron_close", arguments: {} });
  } catch {
    // Best-effort cleanup before closing the bridge.
  }
  await current.client.close().catch(() => undefined);
};

const formatMcpContent = (content: unknown) => {
  if (!Array.isArray(content)) return [{ type: "text" as const, text: JSON.stringify(content, null, 2) }];

  return content.map((item) => {
    if (!item || typeof item !== "object") return { type: "text" as const, text: String(item) };
    const entry = item as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
    if (entry.type === "text" && typeof entry.text === "string") {
      return { type: "text" as const, text: entry.text };
    }
    if (entry.type === "image" && typeof entry.data === "string") {
      return {
        type: "image" as const,
        data: entry.data,
        mimeType: typeof entry.mimeType === "string" ? entry.mimeType : "image/png",
      };
    }
    return { type: "text" as const, text: JSON.stringify(item, null, 2) };
  });
};

export default function (pi: ExtensionAPI) {
  pi.registerTool(
    defineTool({
      name: "ai_secretary_mcp_playwright_electron_list_tools",
      label: "AI Secretary Electron MCP: list tools",
      description: "List tools exposed by the project-local Playwright Electron MCP server.",
      promptSnippet: "ai_secretary_mcp_playwright_electron_list_tools: list Electron app testing tools exposed by the project-local MCP server.",
      parameters: Type.Object({}),
      async execute() {
        const client = await connect();
        const result = await client.listTools();
        const lines = result.tools.map((tool) => {
          const description = tool.description ? ` — ${tool.description}` : "";
          const schema = tool.inputSchema ? `\n  inputSchema: ${JSON.stringify(tool.inputSchema)}` : "";
          return `- ${tool.name}${description}${schema}`;
        });
        return {
          content: [{ type: "text", text: lines.join("\n") || "No Electron MCP tools exposed." }],
          details: result,
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "ai_secretary_mcp_playwright_electron_call_tool",
      label: "AI Secretary Electron MCP: call tool",
      description:
        "Call a tool exposed by the project-local Playwright Electron MCP server. Use ai_secretary_mcp_playwright_electron_list_tools first to discover tool names and arguments.",
      promptSnippet:
        "ai_secretary_mcp_playwright_electron_call_tool: call Electron app testing tools, such as electron_launch, electron_eval_renderer, electron_screenshot, electron_console_messages, and electron_close.",
      parameters: Type.Object({
        name: Type.String({ description: "The exact Electron MCP tool name to call." }),
        arguments: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "JSON arguments for the Electron MCP tool." })),
      }),
      async execute(_toolCallId, params, signal) {
        const client = await connect();
        const result = await client.callTool(
          { name: params.name, arguments: params.arguments ?? {} },
          undefined,
          signal ? { signal } : undefined,
        );
        return {
          content: formatMcpContent(result.content),
          details: result,
          isError: result.isError === true,
        };
      },
    }),
  );

  pi.registerCommand("mcp-playwright-electron-restart", {
    description: "Restart the AI Secretary Playwright Electron MCP server connection",
    handler: async (_args, ctx) => {
      await disconnect();
      await connect();
      ctx.ui.notify("Playwright Electron MCP server restarted", "info");
    },
  });

  pi.on("session_shutdown", async () => {
    await disconnect();
  });
}
