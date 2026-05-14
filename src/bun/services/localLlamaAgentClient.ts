import { spawn } from "bun";
import { existsSync } from "fs";
import path from "path";
import type { AgentClientInstance, AgentQuery, AgentResponse, AgentModelSelection } from "./agent/types";
import { getAppState } from "./app-state";
import type { AgentEventCallback } from "../state/appState";

const DEFAULT_LLAMA_SERVER = "vendor/atomic-llama-cpp-turboquant/build-cuda/bin/llama-server";
const DEFAULT_LOCAL_MODEL = "models/Negentropy-claude-opus-4.7-9B-Q5_K_M.gguf";
const DEFAULT_MM_PROJ = "models/Negentropy_mmproj.gguf";

const VOICE_DECISION_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    decision: { type: "string", enum: ["respond", "no_response"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
    speech: { type: "string" },
  },
  required: ["decision", "confidence", "reason", "speech"],
  additionalProperties: false,
});

export interface LocalLlamaAgentClientOptions {
  modelPath?: string;
  serverPath?: string;
  port?: number;
  host?: string;
  contextSize?: number;
  gpuLayers?: string;
  timeoutMs?: number;
  reasoning?: "on" | "off" | "auto";
  reasoningBudget?: number;
  mmprojPath?: string;
}

function pickPort() {
  return 21000 + Math.floor(Math.random() * 20000);
}

function resolveExistingPath(candidate: string, label: string) {
  const resolved = path.resolve(candidate);
  if (!existsSync(resolved)) throw new Error(`${label} not found: ${resolved}`);
  return resolved;
}

function extractJsonObject(text: string) {
  const withoutThink = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const start = withoutThink.indexOf("{");
  const end = withoutThink.lastIndexOf("}");
  return start >= 0 && end > start ? withoutThink.slice(start, end + 1) : withoutThink;
}

function parseVoiceJsonObject(text: string) {
  const jsonText = extractJsonObject(text);
  const parsed = JSON.parse(jsonText) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("Local voice JSON response was not an object");
  const record = parsed as Record<string, unknown>;
  if (typeof record.speech !== "string") throw new Error("Local voice JSON response missing string speech field");
  return record;
}

function extractSpeechFromVoiceJson(text: string) {
  try {
    return parseVoiceJsonObject(text).speech.trim();
  } catch {
    // Not a voice JSON response.
  }
  return null;
}

function extractUserSpeechFromVoicePrompt(prompt: string) {
  const marker = "[User speech]";
  const markerIndex = prompt.lastIndexOf(marker);
  if (markerIndex < 0) return prompt;
  return prompt.slice(markerIndex + marker.length).trim();
}

function getAppStateOrDefault<K extends Parameters<typeof getAppState>[0]>(key: K, fallback: ReturnType<typeof getAppState<K>>) {
  try {
    return getAppState(key);
  } catch {
    return fallback;
  }
}

async function waitForServer(baseUrl: string, proc: ReturnType<typeof spawn>, timeoutMs: number) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    if (proc.exitCode !== null) {
      throw new Error(`llama-server exited early with code ${proc.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for local llama-server at ${baseUrl}: ${lastError}`);
}

export function createLocalLlamaAgentClient(options: LocalLlamaAgentClientOptions = {}): AgentClientInstance {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? pickPort();
  const baseUrl = `http://${host}:${port}`;
  const modelPath = resolveExistingPath(options.modelPath ?? DEFAULT_LOCAL_MODEL, "Local test model");
  const serverPath = resolveExistingPath(options.serverPath ?? DEFAULT_LLAMA_SERVER, "llama-server");
  const mmprojCandidate = options.mmprojPath ?? DEFAULT_MM_PROJ;
  const mmprojPath = existsSync(path.resolve(mmprojCandidate)) ? path.resolve(mmprojCandidate) : null;
  const contextSize = options.contextSize ?? Number(getAppStateOrDefault("localModel.contextSize", 65_536));
  const gpuLayers = options.gpuLayers ?? "auto";
  const timeoutMs = options.timeoutMs ?? 120_000;
  const reasoning = options.reasoning ?? getAppStateOrDefault("localModel.reasoning", "on");
  const reasoningBudget = options.reasoningBudget ?? Number(getAppStateOrDefault("localModel.reasoningBudget", 500));

  let proc: ReturnType<typeof spawn> | null = null;
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  const visibleMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
  const callbacks = new Set<AgentEventCallback>();

  function emit(event: Parameters<AgentEventCallback>[0]) {
    for (const callback of callbacks) callback(event);
  }

  async function startServer() {
    if (proc) return;
    const args = [
      "--model", modelPath,
      "--host", host,
      "--port", String(port),
      "--ctx-size", String(contextSize),
      "--parallel", "1",
      "--temp", "0",
      "--seed", "42",
      "--jinja",
      "--reasoning", reasoning,
      "--reasoning-format", "none",
      ...(reasoningBudget ? ["--reasoning-budget", String(reasoningBudget)] : []),
      ...(mmprojPath ? ["--mmproj", mmprojPath] : ["--json-schema", VOICE_DECISION_JSON_SCHEMA]),
      "--n-gpu-layers", gpuLayers,
    ];

    console.log(`[local-llama] Starting ${serverPath} ${args.join(" ")}`);
    proc = spawn([serverPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    void (async () => {
      if (!proc) return;
      for await (const chunk of proc.stderr) {
        const text = new TextDecoder().decode(chunk).trimEnd();
        if (text) console.log(`[local-llama stderr] ${text}`);
      }
    })();

    void (async () => {
      if (!proc) return;
      for await (const chunk of proc.stdout) {
        const text = new TextDecoder().decode(chunk).trimEnd();
        if (text) console.log(`[local-llama stdout] ${text}`);
      }
    })();

    await waitForServer(baseUrl, proc, timeoutMs);
  }

  async function stopServer() {
    const current = proc;
    proc = null;
    if (!current) return;
    current.kill("SIGTERM");
    await Promise.race([
      current.exited.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (current.exitCode === null) current.kill("SIGKILL");
  }

  function stopServerSync() {
    proc?.kill("SIGKILL");
    proc = null;
  }

  async function query(params: AgentQuery, options?: { signal?: AbortSignal; ephemeral?: boolean }): Promise<AgentResponse> {
    await startServer();
    emit({ type: "processing", message: "Local model processing..." });
    const wantsRawVoiceJson = params.query.includes("[VoiceMode: ari-decides-json-only]");

    let content = "";
    const completionTokenBudget = reasoning === "off"
      ? 512
      : Math.max(1024, reasoningBudget + 512);

    if (params.context?.screenshot) {
      const imageUrl = params.context.screenshot.startsWith("data:")
        ? params.context.screenshot
        : `data:image/png;base64,${params.context.screenshot}`;
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          temperature: 0,
          max_tokens: Math.max(completionTokenBudget, 768),
          stream: false,
          messages: [
            {
              role: "system",
              content: "You are a strict JSON voice router and screenshot-aware final voice responder. Inspect the image if present. Output only one raw JSON object matching this shape: {\"decision\":\"respond\",\"confidence\":0.95,\"reason\":\"...\",\"speech\":\"...\"}. Never use markdown. Keep reasoning brief and put the actual answer in speech.",
            },
            ...messages.map((message) => ({ role: message.role, content: message.content })),
            {
              role: "user",
              content: [
                { type: "text", text: params.query },
                { type: "image_url", image_url: { url: imageUrl } },
              ],
            },
          ],
        }),
        signal: options?.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        emit({ type: "error", error: body });
        throw new Error(`local llama multimodal query failed: ${response.status} ${body}`);
      }

      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      content = extractJsonObject(data.choices?.[0]?.message?.content ?? "");
    } else {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          temperature: 0,
          max_tokens: completionTokenBudget,
          stream: false,
          response_format: wantsRawVoiceJson ? { type: "json_object" } : undefined,
          messages: [
            {
              role: "system",
              content: "You are a strict JSON voice router. Output only one raw JSON object matching this shape: {\"decision\":\"respond\",\"confidence\":0.95,\"reason\":\"...\",\"speech\":\"...\"}. Never use markdown. Put the actual answer in speech.",
            },
            ...messages.map((message) => ({ role: message.role, content: message.content })),
            { role: "user", content: params.query },
          ],
        }),
        signal: options?.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        emit({ type: "error", error: body });
        throw new Error(`local llama query failed: ${response.status} ${body}`);
      }

      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      content = extractJsonObject(data.choices?.[0]?.message?.content ?? "");
    }
    let responseContent: string;
    let visibleUserContent = params.query;
    let visibleAssistantContent: string;

    if (wantsRawVoiceJson) {
      let parsedVoiceJson: Record<string, unknown>;
      try {
        parsedVoiceJson = parseVoiceJsonObject(content);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit({ type: "error", error: message });
        throw new Error(`Failed to parse local voice JSON response: ${message}. Raw response: ${content}`);
      }
      responseContent = JSON.stringify(parsedVoiceJson);
      visibleUserContent = extractUserSpeechFromVoicePrompt(params.query);
      visibleAssistantContent = String(parsedVoiceJson.speech ?? "").trim();
    } else {
      responseContent = extractSpeechFromVoiceJson(content) ?? content;
      visibleAssistantContent = responseContent;
    }

    messages.push({ role: "user", content: params.query });
    messages.push({ role: "assistant", content: responseContent });
    visibleMessages.push({ role: "user", content: visibleUserContent });
    if (visibleAssistantContent) visibleMessages.push({ role: "assistant", content: visibleAssistantContent });
    emit({ type: "text_delta", delta: responseContent, fullText: responseContent });
    emit({ type: "complete", message: "Done" });
    return { response: responseContent, metadata: { backend: "local-llama", baseUrl, modelPath, rawResponse: content } };
  }

  async function clearSession() {
    messages.length = 0;
    visibleMessages.length = 0;
    return "local-llama-session";
  }

  const model: AgentModelSelection = { providerID: "local-llama", modelID: path.basename(modelPath) };

  return {
    startServer,
    stopServer,
    stopServerSync,
    query,
    injectContext: async (text: string) => {
      messages.push({ role: "user", content: `[Injected context]\n${text}` });
    },
    checkServer: async () => proc !== null,
    getOrCreateSessionId: async () => "local-llama-session",
    clearSession,
    getSessionMessages: async (_sessionID?: string, limit?: number) => {
      const selected = typeof limit === "number" ? visibleMessages.slice(-limit) : visibleMessages;
      return selected.map((message, index) => ({ 
        info: { id: `local-${index}`, role: message.role, time: { created: Date.now() } },
        parts: [{ type: "text", text: message.content }],
      }));
    },
    getDefaultModel: async () => model,
    setSessionModel: () => {},
    getSessionModel: () => model,
    setThinkingLevel: () => {},
    getThinkingLevel: () => "none",
    listProviders: async () => ({ all: [{ id: "local-llama", name: "Local llama.cpp", models: { [model.modelID]: { id: model.modelID, name: model.modelID } } }], default: { "local-llama": model.modelID }, connected: ["local-llama"] }),
    getProviderAuthMethods: async () => ({}),
    setProviderApiKey: async () => {},
    oauthAuthorize: async () => ({}),
    oauthCallback: async () => {},
    onAgentEvent: (callback) => {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    onProgress: () => {},
    getServerStatus: () => proc !== null,
    isManaged: () => true,
    getServerPid: () => proc?.pid ?? null,
  };
}
