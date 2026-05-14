import { getSetting, setSetting } from "./app-state";
import { logDebug, logInfo, logWarn } from "../utils/logger";

export type GBrainIntegrationMode = "mcp" | "cli-call" | "disabled";
export type GBrainWriteMode = "off" | "propose" | "auto";

export interface GBrainStatus {
  installed: boolean;
  configured: boolean;
  healthy: boolean;
  version?: string;
  integrationMode: GBrainIntegrationMode;
  error?: string;
}

export interface GBrainSearchResult {
  slug: string;
  page_id?: number;
  title?: string;
  type?: string;
  chunk_text?: string;
  chunk_source?: string;
  chunk_id?: number;
  chunk_index?: number;
  score?: number;
  stale?: boolean;
  source_id?: string;
}

export interface GBrainPage {
  slug: string;
  title?: string;
  type?: string;
  content?: string;
  compiled_truth?: string;
  timeline?: unknown;
  tags?: string[];
  [key: string]: unknown;
}

interface RunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 2500;
const MAX_CONTEXT_CHARS = 3500;

function getTimeoutMs() {
  const configured = getSetting("gbrain.timeoutMs");
  return configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

function getCommand() {
  const command = getSetting("gbrain.command").trim() || "gbrain";
  validateCommand(command);
  return command;
}

function validateCommand(command: string) {
  if (!command || /\s/.test(command)) {
    throw new Error("Invalid GBrain command. Use a command name or absolute path without spaces.");
  }
}

function getEnv() {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USER", "LANG", "LC_ALL"] as const) {
    const value = process.env[key];
    if (value) env[key] = value;
  }

  const gbrainHome = getSetting("gbrain.home");
  if (gbrainHome && gbrainHome.trim()) {
    env.GBRAIN_HOME = gbrainHome.trim();
  } else if (process.env.GBRAIN_HOME) {
    env.GBRAIN_HOME = process.env.GBRAIN_HOME;
  }

  return env;
}

function decode(buffer: ArrayBuffer) {
  return new TextDecoder().decode(buffer);
}

async function runGBrain(args: string[], options: RunOptions = {}): Promise<RunResult> {
  const command = getCommand();
  const timeoutMs = options.timeoutMs ?? getTimeoutMs();

  if (options.signal?.aborted) {
    throw new DOMException("GBrain call aborted", "AbortError");
  }

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: getEnv(),
    });
  } catch (error) {
    throw new Error(`Failed to start GBrain: ${error instanceof Error ? error.message : String(error)}`);
  }

  let settled = false;
  const abort = () => {
    if (settled) return;
    try {
      proc.kill();
    } catch {
      // ignore kill errors
    }
  };

  const timeout = setTimeout(abort, timeoutMs);
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    const [stdoutBuffer, stderrBuffer, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).arrayBuffer(),
      proc.exited,
    ]);
    settled = true;

    if (stdoutBuffer.byteLength > MAX_OUTPUT_BYTES || stderrBuffer.byteLength > MAX_OUTPUT_BYTES) {
      throw new Error("GBrain output exceeded safety limit");
    }

    const stdout = decode(stdoutBuffer);
    const stderr = decode(stderrBuffer);

    if (options.signal?.aborted) {
      throw new DOMException("GBrain call aborted", "AbortError");
    }

    if (exitCode !== 0) {
      throw new Error(`GBrain exited with code ${exitCode}: ${stderr || stdout || "unknown error"}`);
    }

    return { stdout, stderr, exitCode };
  } finally {
    settled = true;
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

async function callJson<T>(tool: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const result = await runGBrain(["call", tool, JSON.stringify(params)], { signal });
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new Error(`GBrain ${tool} returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function redact(text: string) {
  const redactedTerms = getSetting("privacy.redactedTerms");
  let result = text;
  for (const term of redactedTerms) {
    const trimmed = term.trim();
    if (!trimmed) continue;
    result = result.replaceAll(trimmed, "[REDACTED]");
  }
  return result;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

export function getGBrainSettings() {
  return {
    enabled: getSetting("gbrain.enabled"),
    command: getSetting("gbrain.command"),
    home: getSetting("gbrain.home"),
    integrationMode: getSetting("gbrain.integrationMode"),
    contextLookupEnabled: getSetting("gbrain.contextLookupEnabled"),
    writeMode: getSetting("gbrain.writeMode"),
    timeoutMs: getSetting("gbrain.timeoutMs"),
    maxContextItems: getSetting("gbrain.maxContextItems"),
  };
}

export function updateGBrainSettings(settings: Partial<ReturnType<typeof getGBrainSettings>>) {
  if (settings.enabled !== undefined) setSetting("gbrain.enabled", settings.enabled);
  if (settings.command !== undefined) {
    validateCommand(settings.command.trim());
    setSetting("gbrain.command", settings.command);
  }
  if (settings.home !== undefined) setSetting("gbrain.home", settings.home);
  if (settings.integrationMode !== undefined) setSetting("gbrain.integrationMode", settings.integrationMode);
  if (settings.contextLookupEnabled !== undefined) setSetting("gbrain.contextLookupEnabled", settings.contextLookupEnabled);
  if (settings.writeMode !== undefined) setSetting("gbrain.writeMode", settings.writeMode);
  if (settings.timeoutMs !== undefined) setSetting("gbrain.timeoutMs", settings.timeoutMs);
  if (settings.maxContextItems !== undefined) setSetting("gbrain.maxContextItems", settings.maxContextItems);
  return getGBrainSettings();
}

export async function getGBrainStatus(signal?: AbortSignal): Promise<GBrainStatus> {
  if (!getSetting("gbrain.enabled")) {
    return { installed: false, configured: false, healthy: false, integrationMode: "disabled" };
  }

  try {
    const versionResult = await runGBrain(["version"], { signal, timeoutMs: Math.min(getTimeoutMs(), 2000) });
    const version = versionResult.stdout.trim() || undefined;

    try {
      await runGBrain(["doctor", "--json", "--fast"], { signal, timeoutMs: getTimeoutMs() });
      return {
        installed: true,
        configured: true,
        healthy: true,
        version,
        integrationMode: getSetting("gbrain.integrationMode"),
      };
    } catch (healthError) {
      return {
        installed: true,
        configured: false,
        healthy: false,
        version,
        integrationMode: getSetting("gbrain.integrationMode"),
        error: healthError instanceof Error ? healthError.message : String(healthError),
      };
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      installed: false,
      configured: false,
      healthy: false,
      integrationMode: "disabled",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function searchGBrain(query: string, limit?: number, signal?: AbortSignal): Promise<GBrainSearchResult[]> {
  return callJson<GBrainSearchResult[]>("search", { query: redact(query), limit: limit ?? 10 }, signal);
}

export async function queryGBrain(query: string, limit?: number, signal?: AbortSignal): Promise<GBrainSearchResult[]> {
  return callJson<GBrainSearchResult[]>("query", { query: redact(query), limit: limit ?? 10, expand: false }, signal);
}

export async function getGBrainPage(slug: string, signal?: AbortSignal): Promise<GBrainPage> {
  return callJson<GBrainPage>("get_page", { slug }, signal);
}

export async function putGBrainPage(_slug: string, _content: string, _signal?: AbortSignal): Promise<unknown> {
  throw new Error("GBrain writes are not implemented yet. Add audit/forget/privacy handling before enabling put_page.");
}

function pageText(page: GBrainPage) {
  const parts = [page.compiled_truth, page.content].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  return parts.join("\n\n").replace(/\s+/g, " ").trim();
}

function resultSnippet(result: GBrainSearchResult) {
  return (result.chunk_text ?? "").replace(/\s+/g, " ").trim();
}

export async function buildGBrainContext(question: string, signal?: AbortSignal): Promise<{ context: string; sourceCount: number; slugs: string[] }> {
  if (!getSetting("memory.enabled")) {
    return { context: "", sourceCount: 0, slugs: [] };
  }
  if (!getSetting("gbrain.enabled") || !getSetting("gbrain.contextLookupEnabled")) {
    return { context: "", sourceCount: 0, slugs: [] };
  }

  const maxItems = Math.max(1, getSetting("gbrain.maxContextItems"));

  try {
    const searchResults = await searchGBrain(question, maxItems * 2, signal);
    let results = searchResults;
    if (results.length === 0) {
      results = await queryGBrain(question, maxItems * 2, signal);
    }

    const slugs = [...new Set(results.map((result) => result.slug).filter(Boolean))].slice(0, maxItems);
    if (slugs.length === 0) return { context: "", sourceCount: 0, slugs: [] };

    const lines: string[] = [];
    for (const slug of slugs.slice(0, Math.min(3, maxItems))) {
      if (signal?.aborted) throw new DOMException("GBrain context lookup aborted", "AbortError");
      try {
        const page = await getGBrainPage(slug, signal);
        const text = pageText(page) || resultSnippet(results.find((result) => result.slug === slug) ?? { slug });
        if (text) lines.push(`- ${slug}: ${text.slice(0, 700)}`);
      } catch (error) {
        logDebug(`[GBrain] Failed to fetch page ${slug}; using search snippet`, error);
        const snippet = resultSnippet(results.find((result) => result.slug === slug) ?? { slug });
        if (snippet) lines.push(`- ${slug}: ${snippet.slice(0, 700)}`);
      }
    }

    if (lines.length === 0) return { context: "", sourceCount: 0, slugs };

    const context = `Relevant long-term brain context from GBrain:\n${lines.join("\n")}\n\nUse this as context. Do not claim it came from the current conversation.`.slice(0, MAX_CONTEXT_CHARS);
    logInfo(`[GBrain] Built context from ${lines.length} source(s): ${slugs.join(", ")}`);
    return { context, sourceCount: lines.length, slugs };
  } catch (error) {
    if (isAbortError(error)) throw error;
    logWarn("[GBrain] Context lookup failed; continuing without GBrain:", error);
    return { context: "", sourceCount: 0, slugs: [] };
  }
}
