import { mkdir } from "fs/promises";
import { homedir } from "os";
import path from "path";
import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type McpClientState = {
	client: Client;
	transport: StdioClientTransport;
};

let state: McpClientState | undefined;

const getAiSecretaryDataDir = () => {
	const override = process.env.AI_SECRETARY_DATA_DIR;
	if (override?.trim()) return path.resolve(override);

	if (process.platform === "win32" && process.env.LOCALAPPDATA?.trim()) {
		return path.join(process.env.LOCALAPPDATA, ".ai-secretary");
	}

	return path.join(homedir(), ".ai-secretary");
};

const getPlaywrightMcpPaths = async () => {
	const baseDir = path.join(getAiSecretaryDataDir(), "mcp", "playwright");
	const userDataDir = path.join(baseDir, "user-data");
	const outputDir = path.join(baseDir, "output");
	await mkdir(userDataDir, { recursive: true });
	await mkdir(outputDir, { recursive: true });
	return { userDataDir, outputDir };
};

const getPlaywrightMcpEnv = () => {
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
	]) {
		const value = process.env[key];
		if (value) env[key] = value;
	}
	return env;
};

const connect = async () => {
	if (state) return state.client;

	const { userDataDir, outputDir } = await getPlaywrightMcpPaths();
	const client = new Client(
		{ name: "ai-secretary-local-playwright-mcp-bridge", version: "0.1.0" },
		{ capabilities: {} },
	);
	const transport = new StdioClientTransport({
		command: "bunx",
		args: [
			"@playwright/mcp@latest",
			"--browser",
			"chromium",
			"--user-data-dir",
			userDataDir,
			"--output-dir",
			outputDir,
			"--save-session",
		],
		env: getPlaywrightMcpEnv(),
		stderr: "pipe",
	});

	await client.connect(transport);
	state = { client, transport };
	return client;
};

const disconnect = async () => {
	if (!state) return;
	const current = state;
	state = undefined;
	await current.client.close();
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
			name: "ai_secretary_mcp_playwright_list_tools",
			label: "AI Secretary MCP Playwright: list tools",
			description: "List tools exposed by the AI Secretary local Playwright MCP server.",
			promptSnippet: "ai_secretary_mcp_playwright_list_tools: list browser automation tools exposed by the local Playwright MCP server.",
			parameters: Type.Object({}),
			async execute() {
				const client = await connect();
				const result = await client.listTools();
				const lines = result.tools.map((tool) => {
					const description = tool.description ? ` — ${tool.description}` : "";
					return `- ${tool.name}${description}`;
				});
				return {
					content: [{ type: "text", text: lines.join("\n") || "No MCP tools exposed." }],
					details: result,
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "ai_secretary_mcp_playwright_call_tool",
			label: "AI Secretary MCP Playwright: call tool",
			description:
				"Call a tool exposed by the local AI Secretary Playwright MCP server. Use ai_secretary_mcp_playwright_list_tools first to discover available tool names and arguments.",
			promptSnippet:
				"ai_secretary_mcp_playwright_call_tool: call a Playwright MCP browser automation tool by name with JSON arguments.",
			parameters: Type.Object({
				name: Type.String({ description: "The exact MCP tool name to call." }),
				arguments: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "JSON arguments for the MCP tool." })),
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

	pi.registerCommand("mcp-playwright-restart", {
		description: "Restart the Playwright MCP server connection",
		handler: async (_args, ctx) => {
			await disconnect();
			await connect();
			ctx.ui.notify("Playwright MCP server restarted", "info");
		},
	});

	pi.on("session_shutdown", async () => {
		await disconnect();
	});
}
