import { existsSync } from "fs";
import { mkdir, readFile, stat, truncate, writeFile } from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { Type } from "@mariozechner/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AgentClientInstance, AgentQuery, AgentResponse, AgentModelSelection } from "../agent/types";
import type { AgentEvent, AgentEventCallback } from "../../state/appState";
import { getAiSecretaryDataDir, getPiWorkspaceDir, getProjectPiAgentDir, getProjectRootDir, getResourcesToolsDir } from "../../utils/paths";
import {
  getActiveCompanionPack,
  isCompanionPackCapabilityEnabled,
  readActiveCompanionPersona,
  resolvePackRelativePath,
  type CompanionPack,
} from "../companion-packs";
import { logDebug, logError, logInfo, logWarn } from "../../utils/logger";
import { getAppState, getSetting, setAppState } from "../app-state";
import { resetActiveConversationSession } from "../conversations";
import { ensureManagedChromiumDownloaded, getPlaywrightMcpCliPath } from "../playwright-browser";
import { scrapeFirecrawl, searchFirecrawl } from "../firecrawl";

type PiModule = Record<string, any>;

type McpClientState = {
  client: Client;
  transport: StdioClientTransport;
};

interface PiState {
  pi: PiModule | null;
  session: any | null;
  modelRegistry: any | null;
  unsubscribe: (() => void) | null;
  isStarting: boolean;
  isReady: boolean;
  sessionModelById: Map<string, AgentModelSelection>;
  cachedDefaultModel: AgentModelSelection | null;
  thinkingLevel: string;
  pendingInjectedContext: string[];
  onProgressCallback: ((message: string) => void) | null;
  agentEventCallbacks: Map<string, AgentEventCallback>;
  currentAssistantText: string;
  lastMessageTextByKey: Map<string, string>;
  playwrightMcp: McpClientState | null;
}

const PI_SESSION_ID_KEY = "pi.sessionId";
const PI_SESSION_FILE_KEY = "pi.sessionFile";
const PI_DEFAULT_MODEL_KEY = "pi.defaultModel";
const PI_THINKING_LEVEL_KEY = "pi.thinkingLevel";
const FALLBACK_PI_MODEL: AgentModelSelection = { providerID: "opencode", modelID: "big-pickle" };

function createPiClient(): AgentClientInstance {
  const state: PiState = {
    pi: null,
    session: null,
    modelRegistry: null,
    unsubscribe: null,
    isStarting: false,
    isReady: false,
    sessionModelById: new Map(),
    cachedDefaultModel: null,
    thinkingLevel: "minimal",
    pendingInjectedContext: [],
    onProgressCallback: null,
    agentEventCallbacks: new Map(),
    currentAssistantText: "",
    lastMessageTextByKey: new Map(),
    playwrightMcp: null,
  };

  function emit(event: AgentEvent): void {
    for (const callback of state.agentEventCallbacks.values()) {
      callback(event);
    }
  }

  async function loadPi(): Promise<PiModule> {
    if (state.pi) return state.pi;

    try {
      // Prefer a normal dependency if/when bun can install it successfully.
      state.pi = await import("@mariozechner/pi-coding-agent");
      return state.pi;
    } catch (dependencyError) {
      const packageDir = process.env.AI_SECRETARY_PI_SDK_PATH;
      if (!packageDir) {
        throw new Error(
          `pi SDK is not installed. Install @mariozechner/pi-coding-agent or set AI_SECRETARY_PI_SDK_PATH. ` +
            `Package import error: ${dependencyError instanceof Error ? dependencyError.message : String(dependencyError)}`,
        );
      }

      const indexPath = path.join(packageDir, "dist", "index.js");
      if (!existsSync(indexPath)) {
        throw new Error(`AI_SECRETARY_PI_SDK_PATH does not contain dist/index.js: ${indexPath}`);
      }
      state.pi = await import(pathToFileURL(indexPath).href);
      return state.pi;
    }
  }

  function safeGetAppState(key: string): unknown {
    try {
      return getAppState(key);
    } catch (error) {
      logDebug(`[pi] App state unavailable for ${key}; using default`, error);
      return null;
    }
  }

  function safeSetAppState(key: string, value: string): void {
    try {
      setAppState(key, value);
    } catch (error) {
      logDebug(`[pi] App state unavailable for ${key}; skipping persistence`, error);
    }
  }

  function safeGetSetting(key: "playwright.enabled" | "firecrawl.enabled"): boolean {
    try {
      return getSetting(key);
    } catch (error) {
      logDebug(`[pi] App setting unavailable for ${key}; using default`, error);
      return false;
    }
  }

  function parseModel(model: string): AgentModelSelection | null {
    const parts = model.split("/");
    if (parts.length < 2) return null;
    return { providerID: parts[0], modelID: parts.slice(1).join("/") };
  }

  function serializeModel(model: AgentModelSelection): string {
    return `${model.providerID}/${model.modelID}`;
  }

  function getLocalAgentDir(): string {
    return path.resolve(process.env.AI_SECRETARY_PI_AGENT_DIR ?? getProjectPiAgentDir());
  }

  async function loadPackPersona(): Promise<string | null> {
    try {
      return await readActiveCompanionPersona();
    } catch (error) {
      logWarn("[pi] Failed to read active companion persona:", error);
      return null;
    }
  }

  function getToolEnv(): Record<string, string> {
    const allowed = [
      "PATH",
      "HOME",
      "USER",
      "DISPLAY",
      "WAYLAND_DISPLAY",
      "XDG_RUNTIME_DIR",
      "DBUS_SESSION_BUS_ADDRESS",
      "XAUTHORITY",
      "XDG_SESSION_TYPE",
      "GDK_BACKEND",
      "QT_QPA_PLATFORM",
    ];
    const env: Record<string, string> = { AI_SECRETARY_PROJECT_ROOT: getProjectRootDir() };
    for (const key of allowed) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    return env;
  }

  function getPlaywrightMcpEnv(): Record<string, string> {
    return { ...getDefaultEnvironment(), ...getToolEnv() };
  }

  async function getPlaywrightMcpPaths() {
    const baseDir = path.join(getAiSecretaryDataDir(), "mcp", "playwright");
    const userDataDir = path.join(baseDir, "user-data");
    const outputDir = path.join(baseDir, "output");
    await mkdir(userDataDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    return { userDataDir, outputDir };
  }

  async function connectPlaywrightMcp() {
    if (state.playwrightMcp) return state.playwrightMcp.client;

    const { userDataDir, outputDir } = await getPlaywrightMcpPaths();
    const executablePath = await ensureManagedChromiumDownloaded((message) => logInfo(`[pi] ${message}`));
    const client = new Client(
      { name: "ai-secretary-playwright-mcp", version: "0.1.0" },
      { capabilities: {} },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        getPlaywrightMcpCliPath(),
        "--browser",
        "chromium",
        "--executable-path",
        executablePath,
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
    state.playwrightMcp = { client, transport };
    logInfo(`[pi] Playwright MCP connected with persistent profile: ${userDataDir}`);
    return client;
  }

  async function disconnectPlaywrightMcp(): Promise<void> {
    if (!state.playwrightMcp) return;
    const current = state.playwrightMcp;
    state.playwrightMcp = null;
    await current.client.close();
  }

  function formatMcpContent(content: unknown) {
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
  }

  function createPlaywrightMcpTools(pi: PiModule) {
    return [
      pi.defineTool({
        name: "ai_secretary_mcp_playwright_list_tools",
        label: "AI Secretary MCP Playwright: list tools",
        description: "List tools exposed by the AI Secretary local Playwright MCP server.",
        promptSnippet: "ai_secretary_mcp_playwright_list_tools: list browser automation tools exposed by the local Playwright MCP server.",
        parameters: Type.Object({}),
        async execute() {
          const client = await connectPlaywrightMcp();
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
      pi.defineTool({
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
        async execute(_toolCallId: string, params: { name: string; arguments?: Record<string, unknown> }, signal?: AbortSignal) {
          const client = await connectPlaywrightMcp();
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
    ];
  }

  function createFirecrawlTools(pi: PiModule) {
    return [
      pi.defineTool({
        name: "web_search",
        label: "Web Search",
        description: "Search the web using Firecrawl. Use this for current information, recent events, websites, products, docs, or anything likely to have changed.",
        promptSnippet: "web_search: search the web using Firecrawl for current information. Parameters: query, limit, scrapeResults.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query." }),
          limit: Type.Optional(Type.Number({ description: "Maximum results, 1-10. Default 5." })),
          scrapeResults: Type.Optional(Type.Boolean({ description: "Include markdown content from result pages when available. Default false." })),
        }),
        async execute(_toolCallId: string, params: { query: string; limit?: number; scrapeResults?: boolean }) {
          const result = await searchFirecrawl(params);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
        },
      }),
      pi.defineTool({
        name: "web_scrape",
        label: "Web Scrape",
        description: "Fetch and convert a known URL to readable markdown using Firecrawl. Use web_search first when you do not already know the URL.",
        promptSnippet: "web_scrape: fetch a known URL as readable markdown using Firecrawl. Parameters: url, onlyMainContent.",
        parameters: Type.Object({
          url: Type.String({ description: "URL to scrape." }),
          onlyMainContent: Type.Optional(Type.Boolean({ description: "Extract only main page content. Default true." })),
        }),
        async execute(_toolCallId: string, params: { url: string; onlyMainContent?: boolean }) {
          const result = await scrapeFirecrawl(params);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
        },
      }),
    ];
  }

  function createResourceScriptTool(pi: PiModule, workspaceDir: string, config: { name: string; label: string; description: string; script: string }) {
    return pi.defineTool({
      name: config.name,
      label: config.label,
      description: config.description,
      promptSnippet: `${config.name}: ${config.description}`,
      parameters: Type.Object({
        args: Type.Array(Type.String(), { description: "Command-line arguments to pass to the tool script." }),
      }),
      async execute(_toolCallId: string, params: { args?: string[] }) {
        const scriptPath = path.join(getResourcesToolsDir(), config.script);
        const proc = Bun.spawn(["bun", scriptPath, ...(params.args ?? [])], {
          cwd: workspaceDir,
          stdout: "pipe",
          stderr: "pipe",
          env: getToolEnv(),
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        const text = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
        return {
          content: [{ type: "text", text: text || `Tool exited with code ${exitCode}` }],
          isError: exitCode !== 0,
          details: { exitCode },
        };
      },
    });
  }

  function createPiTools(pi: PiModule, workspaceDir: string, pack: CompanionPack) {
    const toolConfigs = [
      {
        capability: "memory",
        config: {
          name: "search_brain",
          label: "Search Brain",
          description: "Brain-first lookup over Ari's long-term semantic memory using GBrain-style page/chunk results. Use this before answering questions that may depend on remembered facts, preferences, projects, summaries, or past conversations. Example args: [\"--query\", \"answer style preference\", \"--limit\", \"5\"]",
          script: "search-brain.ts",
        },
      },
      {
        capability: "memory",
        config: {
          name: "get_brain_page",
          label: "Get Brain Page",
          description: "Read a full GBrain-style Ari brain page by slug, such as people/user, daily/YYYY-MM-DD, or memory/interactions/<id>. Use after search_brain when a result slug looks relevant.",
          script: "get-brain-page.ts",
        },
      },
      {
        capability: "memory",
        config: {
          name: "search_memory",
          label: "Search Memory",
          description: "Search Ari's raw interaction memory safely by keywords. Prefer search_brain for normal long-term context lookup. Example args: [\"--query\", \"vitamins workout\", \"--limit\", \"5\"]",
          script: "search-memory.ts",
        },
      },
      {
        capability: "memory",
        config: {
          name: "search_audio_transcripts",
          label: "Search Audio Transcripts",
          description: "Search local microphone and speaker transcript history. Use when the user asks what was heard, said aloud, played through speakers, or mentioned in a call/video. Results include source labels (microphone or speaker). Example args: [\"--query\", \"deadline\", \"--source\", \"all\", \"--limit\", \"5\"] or [\"--minutes\", \"10\"].",
          script: "search-audio-transcripts.ts",
        },
      },
      {
        capability: "memory",
        config: {
          name: "get_user_profile",
          label: "Get User Profile",
          description: "Read Ari's current learned user profile markdown.",
          script: "get-user-profile.ts",
        },
      },
      {
        capability: "memory",
        config: {
          name: "get_day_summary",
          label: "Get Day Summary",
          description: "Read recent daily summaries, or pass a YYYY-MM-DD date as the first arg.",
          script: "get-day-summary.ts",
        },
      },
      {
        capability: "memory",
        config: {
          name: "get_recent_conversations",
          label: "Get Recent Conversations",
          description: "List recent reconstructed conversation sessions. Optional first arg is limit.",
          script: "get-recent-conversations.ts",
        },
      },
      {
        capability: "reminders",
        config: {
          name: "manage_reminders",
          label: "Manage Reminders",
          description: "Manage Ari's one-time reminders and timers.",
          script: "manage-reminders.ts",
        },
      },
      {
        capability: "lists",
        config: {
          name: "manage_lists",
          label: "Manage Lists",
          description: "Manage Ari's named lists and list items.",
          script: "manage-lists.ts",
        },
      },
      {
        capability: "routines",
        config: {
          name: "manage_routines",
          label: "Manage Routines",
          description: "Manage Ari's goal-driven routines and recurring reminders. Supports simple CRUD plus create-agentic --spec JSON for best-state routines with triggers, guards/conditions, context requests, action graphs, permissions, durable routine state, evaluation, and delivery policy. Use this tool instead of promising to remember routines.",
          script: "manage-routines.ts",
        },
      },
      {
        capability: "tasks",
        config: {
          name: "manage_tasks",
          label: "Manage Tasks",
          description: "Manage Ari's first-class user tasks/todos.",
          script: "manage-tasks.ts",
        },
      },
      {
        capability: "screenshots",
        config: {
          name: "capture_screenshot",
          label: "Capture Screenshot",
          description: "Capture the active window or full screen and save OCR metadata to memory.",
          script: "capture-screenshot.ts",
        },
      },
    ] as const;

    const tools = [
      pi.defineTool({
        name: "companion_set_state",
        label: "Set Companion State",
        description: "Change the companion avatar's persistent base sprite/status. Use this when a persistent visual state change is clearly intended. The status must be one of the active companion pack's declared states; custom user packs may define their own status names.",
        promptSnippet: `companion_set_state: Change the companion avatar's persistent base state/status. Allowed statuses for this pack: ${pack.manifest.markers.states.join(", ") || "(none)"}. Use this instead of emitting [state:*] markers.`,
        parameters: Type.Object({
          status: Type.String({ description: "The target persistent avatar status/state from the active companion pack's allowed states." }),
          reason: Type.Optional(Type.String({ description: "Brief reason for the state change." })),
        }),
        async execute(_toolCallId: string, params: { status?: string; reason?: string }) {
          const status = String(params.status ?? "").trim();
          const allowedStates = new Set(pack.manifest.markers.states);
          if (!status || !allowedStates.has(status)) {
            return {
              content: [{ type: "text", text: `Invalid companion state '${status || "(empty)"}'. Allowed states: ${pack.manifest.markers.states.join(", ") || "(none)"}.` }],
              isError: true,
              details: { allowedStates: pack.manifest.markers.states },
            };
          }

          try {
            setAppState("secretary.status", status);
          } catch (error) {
            logWarn(`[pi] Failed to persist secretary.status=${status}:`, error);
          }
          emit({ type: "avatar_status", status, reason: params.reason });
          return {
            content: [{ type: "text", text: `Companion state changed to ${status}.` }],
            details: { status, reason: params.reason },
          };
        },
      }),
      ...toolConfigs
        .filter(({ capability }) => isCompanionPackCapabilityEnabled(pack, capability))
        .map(({ config }) => createResourceScriptTool(pi, workspaceDir, config)),
    ];

    if (process.env.AI_SECRETARY_ENABLE_DEBUG_SQL_TOOL === "1" && isCompanionPackCapabilityEnabled(pack, "memory")) {
      tools.push(createResourceScriptTool(pi, workspaceDir, {
        name: "query_memory",
        label: "Query Memory (Debug)",
        description: "Developer-only raw SQL memory queries. Use only when the safer memory tools are insufficient.",
        script: "query-memory.ts",
      }));
    }

    if (isCompanionPackCapabilityEnabled(pack, "playwright") && safeGetSetting("playwright.enabled") === true) {
      tools.push(...createPlaywrightMcpTools(pi));
    }

    if (isCompanionPackCapabilityEnabled(pack, "websearch") && safeGetSetting("firecrawl.enabled") === true) {
      tools.push(...createFirecrawlTools(pi));
    }

    return tools;
  }

  function buildPackContext(pack: CompanionPack) {
    const states = pack.manifest.markers.states.join(", ");
    const anims = pack.manifest.markers.animations.join(", ");
    const capabilities = Object.entries(pack.manifest.capabilities);
    const packEnabledCapabilities = capabilities.filter(([, enabled]) => enabled).map(([key]) => key);
    const packDisabledCapabilities = capabilities.filter(([, enabled]) => !enabled).map(([key]) => key);
    const runtimeEnabledTools = [
      ...capabilities
        .filter(([key, enabled]) => enabled && key !== "playwright" && key !== "websearch")
        .map(([key]) => key),
      ...(isCompanionPackCapabilityEnabled(pack, "playwright") && safeGetSetting("playwright.enabled") === true ? ["playwright"] : []),
      ...(isCompanionPackCapabilityEnabled(pack, "websearch") && safeGetSetting("firecrawl.enabled") === true ? ["websearch"] : []),
    ];
    const runtimeDisabledTools = [
      ...(isCompanionPackCapabilityEnabled(pack, "playwright") && safeGetSetting("playwright.enabled") !== true ? ["playwright (disabled in Settings)"] : []),
      ...(isCompanionPackCapabilityEnabled(pack, "websearch") && safeGetSetting("firecrawl.enabled") !== true ? ["websearch (disabled in Settings)"] : []),
      ...packDisabledCapabilities,
    ];
    const websearchInstruction = runtimeEnabledTools.includes("websearch")
      ? "\n\nWeb search/scrape is currently available. Use it for current or online information. Good examples include weather, stocks/market prices, recent news, current product details, documentation, local businesses/hours, release notes, and factual claims likely to have changed."
      : "";
    return `# Active companion pack\n\n- id: ${pack.manifest.id}\n- name: ${pack.manifest.name}\n- default state: ${pack.manifest.sprites.defaultStatus}\n- allowed companion states/statuses: ${states || "(none)"}\n- allowed [anim:*] markers: ${anims || "(none)"}\n- pack-supported capabilities: ${packEnabledCapabilities.join(", ") || "(none)"}\n- currently available tools/capabilities: ${runtimeEnabledTools.join(", ") || "(none)"}\n- currently unavailable tools/capabilities: ${runtimeDisabledTools.join(", ") || "(none)"}\n\nUse the companion_set_state tool for persistent companion state/status changes. Do not emit [state:*] markers. Only emit [anim:*] markers declared by the active companion pack. Only use tools and behaviors listed as currently available.${websearchInstruction}`;
  }

  async function ensureLocalPiFiles(agentDir: string): Promise<void> {
    await mkdir(agentDir, { recursive: true });

    const modelsPath = process.env.AI_SECRETARY_PI_MODELS_PATH ?? path.join(agentDir, "models.json");
    if (!existsSync(modelsPath)) {
      await writeFile(
        modelsPath,
        `${JSON.stringify(
          {
            providers: {
              opencode: {
                modelOverrides: {
                  "big-pickle": {
                    name: "Big Pickle",
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                },
              },
            },
          },
          null,
          2,
        )}\n`,
        { mode: 0o644 },
      );
    }
  }

  function seedLocalZenApiKey(authStorage: any): void {
    const key = process.env.AI_SECRETARY_PI_OPENCODE_API_KEY ?? process.env.OPENCODE_API_KEY;
    if (!key?.trim()) return;
    authStorage.set("opencode", { type: "api_key", key: key.trim() });
  }

  async function resolveModel(modelRegistry: any, selection: AgentModelSelection) {
    return modelRegistry.find(selection.providerID, selection.modelID) ?? modelRegistry.find(FALLBACK_PI_MODEL.providerID, FALLBACK_PI_MODEL.modelID);
  }

  function mapThinkingLevel(variant: string) {
    const allowed = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
    return allowed.has(variant) ? variant : "minimal";
  }

  function getSessionId(): string | null {
    return state.session?.sessionId ?? state.session?.id ?? null;
  }

  function flattenMessageText(message: any): string {
    if (!message) return "";
    if (typeof message.text === "string") return message.text;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.parts)) {
      return message.parts
        .map((part: any) => part?.text ?? part?.content ?? "")
        .filter((text: unknown) => typeof text === "string" && text.length > 0)
        .join("\n");
    }
    if (Array.isArray(message.content)) {
      return message.content
        .map((part: any) => part?.text ?? part?.content ?? "")
        .filter((text: unknown) => typeof text === "string" && text.length > 0)
        .join("\n");
    }
    return "";
  }

  function getMessageRole(message: any): string {
    return message?.role ?? message?.info?.role ?? message?.type ?? "unknown";
  }

  function getLastAssistantText(): string {
    const messages = Array.isArray(state.session?.messages) ? state.session.messages : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      const role = getMessageRole(message);
      if (role === "assistant") {
        const text = flattenMessageText(message);
        if (text.length > 0) return text;
      }
    }
    return state.currentAssistantText;
  }

  function handlePiEvent(event: any): void {
    try {
      logDebug("[pi] event", event?.type ?? "unknown");

      if (event?.type === "message_update") {
        const assistantEvent = event.assistantMessageEvent ?? event.messageEvent ?? event.event;
        const eventType = assistantEvent?.type;

        if (eventType === "text_delta") {
          const delta = String(assistantEvent.delta ?? "");
          state.currentAssistantText += delta;
          emit({ type: "text_delta", delta, fullText: state.currentAssistantText });
          return;
        }

        if (eventType === "reasoning_delta" || eventType === "thinking_delta") {
          emit({ type: "thought_delta", thought: String(assistantEvent.delta ?? assistantEvent.text ?? "") });
          return;
        }

        if (eventType === "tool_start" || eventType === "tool_call_start") {
          emit({
            type: "tool_start",
            toolName: String(assistantEvent.toolName ?? assistantEvent.name ?? "tool"),
            message: String(assistantEvent.message ?? `Using ${assistantEvent.toolName ?? assistantEvent.name ?? "tool"}...`),
            args: assistantEvent.args ?? assistantEvent.input,
            callId: assistantEvent.callId ?? assistantEvent.id,
          });
          return;
        }

        if (eventType === "tool_end" || eventType === "tool_result" || eventType === "tool_call_end") {
          emit({
            type: "tool_end",
            toolName: String(assistantEvent.toolName ?? assistantEvent.name ?? "tool"),
            message: String(assistantEvent.message ?? `Finished ${assistantEvent.toolName ?? assistantEvent.name ?? "tool"}`),
            args: assistantEvent.args ?? assistantEvent.input,
            result: assistantEvent.result ?? assistantEvent.output,
            callId: assistantEvent.callId ?? assistantEvent.id,
          });
          return;
        }
      }

      if (event?.type === "error") {
        emit({ type: "error", error: String(event.error ?? event.message ?? "pi error") });
        return;
      }

      if (event?.type === "status" || event?.type === "processing") {
        emit({ type: "processing", message: String(event.message ?? "Processing...") });
        return;
      }

      // Fallback for message snapshots: compute deltas when pi sends full message updates.
      const message = event?.message ?? event?.assistantMessage ?? null;
      if (message && getMessageRole(message) === "assistant") {
        const key = String(message.id ?? message.info?.id ?? "assistant");
        const text = flattenMessageText(message);
        const last = state.lastMessageTextByKey.get(key) ?? "";
        if (text.length > last.length && text.startsWith(last)) {
          const delta = text.slice(last.length);
          state.currentAssistantText = text;
          state.lastMessageTextByKey.set(key, text);
          emit({ type: "text_delta", delta, fullText: text });
        }
      }
    } catch (error) {
      logWarn("[pi] Failed to handle event:", error);
    }
  }

  async function createSession(options: { fresh?: boolean } = {}): Promise<void> {
    const pi = await loadPi();
    const dataDir = getAiSecretaryDataDir();
    const piDir = path.join(dataDir, "pi");
    const agentDir = getLocalAgentDir();
    const authPath = process.env.AI_SECRETARY_PI_AUTH_PATH ?? path.join(agentDir, "auth.json");
    const modelsPath = process.env.AI_SECRETARY_PI_MODELS_PATH ?? path.join(agentDir, "models.json");
    const sessionDir = process.env.AI_SECRETARY_PI_SESSION_DIR ?? path.join(piDir, "sessions");
    const workspaceDir = getPiWorkspaceDir();
    const resourceCwd = getProjectRootDir();
    const activePack = await getActiveCompanionPack();

    await mkdir(piDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await ensureLocalPiFiles(agentDir);

    const authStorage = pi.AuthStorage.create(authPath);
    seedLocalZenApiKey(authStorage);
    const modelRegistry = pi.ModelRegistry.create(authStorage, modelsPath);
    state.modelRegistry = modelRegistry;
    const packDefaultModel = activePack.manifest.model ?? FALLBACK_PI_MODEL;
    const selectedModel = await resolveModel(modelRegistry, state.cachedDefaultModel ?? packDefaultModel);
    if (!selectedModel) {
      throw new Error("Unable to find pi model opencode/big-pickle in the local model registry");
    }
    const ariPersona = await loadPackPersona();
    const packContext = buildPackContext(activePack);
    const loader = new pi.DefaultResourceLoader({
      cwd: resourceCwd,
      agentDir,
      additionalExtensionPaths: activePack.manifest.extensionsDir
        ? [resolvePackRelativePath(activePack, activePack.manifest.extensionsDir)]
        : [],
      additionalSkillPaths: activePack.manifest.skillsDir
        ? [resolvePackRelativePath(activePack, activePack.manifest.skillsDir)]
        : [],
      agentsFilesOverride: (current: any) => ({
        ...current,
        agentsFiles: ariPersona
          ? [
              ...(Array.isArray(current?.agentsFiles) ? current.agentsFiles : []),
              { path: path.join(activePack.packDir, activePack.manifest.persona), content: ariPersona },
              { path: path.join(activePack.packDir, "PACK.md"), content: packContext },
            ]
          : [...(current?.agentsFiles ?? []), { path: path.join(activePack.packDir, "PACK.md"), content: packContext }],
      }),
    });
    await loader.reload();

    const sessionManager = options.fresh
      ? pi.SessionManager.create(workspaceDir, sessionDir)
      : pi.SessionManager.continueRecent(workspaceDir, sessionDir);
    const result = await pi.createAgentSession({
      cwd: workspaceDir,
      sessionManager,
      authStorage,
      modelRegistry,
      model: selectedModel,
      resourceLoader: loader,
      customTools: createPiTools(pi, workspaceDir, activePack),
    });

    state.session = result.session;
    state.unsubscribe?.();
    state.unsubscribe = state.session.subscribe((event: any) => handlePiEvent(event));

    state.session.setThinkingLevel?.(mapThinkingLevel(state.thinkingLevel));

    const sid = getSessionId();
    if (sid) safeSetAppState(PI_SESSION_ID_KEY, sid);
    if (state.session.sessionFile) safeSetAppState(PI_SESSION_FILE_KEY, state.session.sessionFile);
  }

  async function startServer(): Promise<void> {
    if (state.isReady) return;
    if (state.isStarting) {
      while (state.isStarting) await new Promise((resolve) => setTimeout(resolve, 100));
      return;
    }

    state.isStarting = true;
    state.onProgressCallback?.("Starting pi SDK session...");
    try {
      await createSession();
      state.isReady = true;
      state.onProgressCallback?.("pi SDK session ready");
      logInfo("[pi] SDK session ready");
    } catch (error) {
      state.isReady = false;
      logError("[pi] Failed to start SDK session:", error);
      throw error;
    } finally {
      state.isStarting = false;
    }
  }

  function composePrompt(query: string, options?: { consumeInjectedContext?: boolean }): string {
    if (state.pendingInjectedContext.length === 0) return query;
    const context = options?.consumeInjectedContext === false
      ? state.pendingInjectedContext.join("\n\n")
      : state.pendingInjectedContext.splice(0).join("\n\n");
    return `[Injected context since last reply]\n${context}\n\n[User message]\n${query}`;
  }

  function toPiImage(screenshot: string) {
    const data = screenshot.includes(",") ? screenshot.split(",").pop() ?? screenshot : screenshot;
    return {
      type: "image",
      source: {
        type: "base64",
        mediaType: "image/png",
        data,
      },
    };
  }

  async function query(params: AgentQuery, options?: { signal?: AbortSignal; ephemeral?: boolean }): Promise<AgentResponse> {
    await startServer();
    if (!state.session) throw new Error("pi session not initialized");

    state.currentAssistantText = "";
    state.lastMessageTextByKey.clear();
    emit({ type: "processing", message: "Processing..." });

    const abort = () => {
      void state.session?.abort?.();
    };
    options?.signal?.addEventListener("abort", abort, { once: true });

    try {
      const messageCountBeforePrompt = Array.isArray(state.session.messages) ? state.session.messages.length : null;
      const sessionFileBeforePrompt = options?.ephemeral === true && state.session.sessionFile ? String(state.session.sessionFile) : null;
      const sessionFileSizeBeforePrompt = sessionFileBeforePrompt
        ? await stat(sessionFileBeforePrompt).then((result) => result.size).catch(() => null)
        : null;
      const prompt = composePrompt(params.query, { consumeInjectedContext: options?.ephemeral !== true });
      const promptOptions: Record<string, unknown> = {};
      if (params.context?.screenshot) {
        promptOptions.images = [toPiImage(params.context.screenshot)];
      }
      await state.session.prompt(prompt, promptOptions);
      if (options?.signal?.aborted) throw new Error("Query aborted");
      const finalText = getLastAssistantText();
      if (options?.ephemeral === true && typeof messageCountBeforePrompt === "number" && Array.isArray(state.session.messages)) {
        state.session.messages.splice(messageCountBeforePrompt);
      }
      if (sessionFileBeforePrompt && typeof sessionFileSizeBeforePrompt === "number") {
        await truncate(sessionFileBeforePrompt, sessionFileSizeBeforePrompt).catch((error) => {
          logWarn("[pi] Failed to remove ephemeral prompt from persisted session log:", error);
        });
      }
      emit({ type: "complete", message: "Done" });
      return {
        response: finalText,
        metadata: {
          sessionID: getSessionId(),
          backend: "pi",
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "error", error: message });
      throw new Error(`Failed to communicate with pi: ${message}`);
    } finally {
      options?.signal?.removeEventListener("abort", abort);
    }
  }

  async function clearSession(): Promise<string> {
    resetActiveConversationSession();
    state.unsubscribe?.();
    state.session?.dispose?.();
    await disconnectPlaywrightMcp();
    state.session = null;
    state.modelRegistry = null;
    state.unsubscribe = null;
    state.isReady = false;
    state.isStarting = true;
    try {
      await createSession({ fresh: true });
      state.isReady = true;
    } finally {
      state.isStarting = false;
    }
    const sid = getSessionId();
    if (!sid) throw new Error("Failed to create pi session");
    return sid;
  }

  async function getSessionMessages(_sessionID?: string, limit?: number): Promise<unknown[]> {
    await startServer();
    const messages = Array.isArray(state.session?.messages) ? state.session.messages : [];
    const selected = typeof limit === "number" && limit > 0 ? messages.slice(-Math.floor(limit)) : messages;
    return selected.map((message: any, idx: number) => ({
      info: {
        id: String(message?.id ?? `pi-message-${idx}`),
        role: getMessageRole(message),
        time: { created: typeof message?.timestamp === "number" ? message.timestamp : Date.now() },
      },
      parts: [{ type: "text", text: flattenMessageText(message) }],
    }));
  }

  async function getDefaultModel(): Promise<AgentModelSelection> {
    if (state.cachedDefaultModel) return state.cachedDefaultModel;
    const saved = safeGetAppState(PI_DEFAULT_MODEL_KEY);
    if (typeof saved === "string") {
      const parsed = parseModel(saved);
      if (parsed) {
        state.cachedDefaultModel = parsed;
        return parsed;
      }
    }
    const activePack = await getActiveCompanionPack();
    state.cachedDefaultModel = activePack.manifest.model ?? FALLBACK_PI_MODEL;
    return state.cachedDefaultModel;
  }

  return {
    startServer,
    stopServer: async () => {
      resetActiveConversationSession();
      state.unsubscribe?.();
      state.session?.dispose?.();
      await disconnectPlaywrightMcp();
      state.unsubscribe = null;
      state.session = null;
      state.modelRegistry = null;
      state.isReady = false;
    },
    stopServerSync: () => {
      resetActiveConversationSession();
      state.unsubscribe?.();
      state.session?.dispose?.();
      void disconnectPlaywrightMcp();
      state.unsubscribe = null;
      state.session = null;
      state.modelRegistry = null;
      state.isReady = false;
    },
    query,
    injectContext: async (text: string) => {
      state.pendingInjectedContext.push(text);
    },
    checkServer: async () => state.isReady,
    getOrCreateSessionId: async () => {
      await startServer();
      const sid = getSessionId();
      if (!sid) throw new Error("pi session has no session id");
      return sid;
    },
    clearSession,
    getSessionMessages,
    getDefaultModel,
    setSessionModel: (sessionID: string, model: AgentModelSelection) => {
      const availableProviders = new Set((state.modelRegistry?.getAvailable?.() ?? []).map((entry: any) => String(entry.provider)));
      if (availableProviders.size > 0 && !availableProviders.has(model.providerID)) {
        throw new Error(`Provider is not configured or connected: ${model.providerID}`);
      }

      const piModel = state.modelRegistry?.find?.(model.providerID, model.modelID);
      if (!piModel) {
        throw new Error(`Model not found in registry: ${serializeModel(model)}`);
      }

      state.sessionModelById.set(sessionID, model);
      state.cachedDefaultModel = model;
      safeSetAppState(PI_DEFAULT_MODEL_KEY, serializeModel(model));

      if (piModel) {
        void state.session?.setModel?.(piModel).catch((error: unknown) => logWarn("[pi] Failed to set session model:", error));
      } else {
        logWarn(`[pi] Could not find model ${serializeModel(model)} in registry`);
      }
    },
    getSessionModel: (sessionID: string) => state.sessionModelById.get(sessionID) ?? state.cachedDefaultModel,
    setThinkingLevel: (variant: string) => {
      state.thinkingLevel = variant;
      safeSetAppState(PI_THINKING_LEVEL_KEY, variant);
      state.session?.setThinkingLevel?.(mapThinkingLevel(variant));
    },
    getThinkingLevel: () => state.thinkingLevel,
    listProviders: async () => {
      const model = await getDefaultModel();
      await startServer();
      const models = state.modelRegistry?.getAll?.() ?? [];
      const providers = new Map<string, { id: string; name: string; models: Record<string, { id: string; name: string }> }>();
      for (const entry of models) {
        const providerID = String(entry.provider ?? "unknown");
        const provider = providers.get(providerID) ?? {
          id: providerID,
          name: state.modelRegistry?.getProviderDisplayName?.(providerID) ?? providerID,
          models: {},
        };
        provider.models[String(entry.id)] = { id: String(entry.id), name: String(entry.name ?? entry.id) };
        providers.set(providerID, provider);
      }
      return {
        default: { [model.providerID]: model.modelID },
        all: Array.from(providers.values()),
        connected: Array.from(new Set((state.modelRegistry?.getAvailable?.() ?? []).map((entry: any) => entry.provider))),
      };
    },
    getProviderAuthMethods: async () => ({
      opencode: [{ type: "api", label: "OpenCode Zen API key" }],
    }),
    setProviderApiKey: async (providerID: string, apiKey: string) => {
      const pi = await loadPi();
      const provider = providerID === "pi" ? "opencode" : providerID;
      const authPath = process.env.AI_SECRETARY_PI_AUTH_PATH ?? path.join(getLocalAgentDir(), "auth.json");
      await mkdir(path.dirname(authPath), { recursive: true });
      const authStorage = pi.AuthStorage.create(authPath);
      authStorage.set(provider, { type: "api_key", key: apiKey });
    },
    oauthAuthorize: async () => ({
      type: "unsupported",
      message: "OAuth is not supported for the embedded pi backend yet. Use an OpenCode Zen API key.",
    }),
    oauthCallback: async () => {
      logWarn("[pi] Ignoring OAuth callback because embedded pi OAuth is unsupported");
    },
    onAgentEvent: (callback: AgentEventCallback) => {
      const id = `pi_cb_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      state.agentEventCallbacks.set(id, callback);
      return () => state.agentEventCallbacks.delete(id);
    },
    onProgress: (callback: (message: string) => void) => {
      state.onProgressCallback = callback;
    },
    getServerStatus: () => state.isReady,
    isManaged: () => false,
    getServerPid: () => null,
  };
}

let client: AgentClientInstance | null = null;

export function getPiClient(): AgentClientInstance {
  client ??= createPiClient();
  return client;
}
