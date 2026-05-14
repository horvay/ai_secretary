#!/usr/bin/env bun
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const projectRoot = resolve(import.meta.dir, "..");
let appProcess: ChildProcess | null = null;
let cdpPort: number | null = null;
let pageTarget: { id: string; title: string; url: string; webSocketDebuggerUrl: string } | null = null;
let consoleMessages: string[] = [];
let cdpSeq = 0;

function text(content: unknown) {
  return { content: [{ type: "text" as const, text: typeof content === "string" ? content : JSON.stringify(content, null, 2) }] };
}

function electronExecutable() {
  const bin = process.platform === "win32" ? "electron.cmd" : "electron";
  return join(projectRoot, "node_modules", ".bin", bin);
}

function builtMainPath() {
  return join(projectRoot, "build", "electron", "main.cjs");
}

async function ensureBuild() {
  if (existsSync(builtMainPath())) return;
  await new Promise<void>((resolveBuild, rejectBuild) => {
    const build = spawn("bun", ["run", "build"], { cwd: projectRoot, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    build.stdout.on("data", (chunk) => process.stderr.write(`[electron-mcp build] ${chunk}`));
    build.stderr.on("data", (chunk) => process.stderr.write(`[electron-mcp build] ${chunk}`));
    build.on("error", rejectBuild);
    build.on("exit", (code) => code === 0 ? resolveBuild() : rejectBuild(new Error(`bun run build exited with code ${code}`)));
  });
}

async function refreshPageTarget(timeoutMs = 10_000) {
  if (!cdpPort) throw new Error("Electron app is not launched. Call electron_launch first.");
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      if (response.ok) {
        const targets = await response.json() as Array<{ id: string; type: string; title: string; url: string; webSocketDebuggerUrl: string }>;
        const page = targets.find((target) => target.type === "page" && !target.url.startsWith("devtools://"));
        if (page) {
          pageTarget = { id: page.id, title: page.title, url: page.url, webSocketDebuggerUrl: page.webSocketDebuggerUrl };
          return pageTarget;
        }
      }
    } catch {}
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 100));
  }
  throw new Error("Timed out waiting for Electron renderer target");
}

async function cdpCall(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000) {
  const target = pageTarget ?? await refreshPageTarget(timeoutMs);
  const id = ++cdpSeq;
  return await new Promise<any>((resolveCall, rejectCall) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      rejectCall(new Error(`Timed out waiting for CDP ${method}`));
    }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id, method, params }));
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      clearTimeout(timer);
      ws.close();
      message.error ? rejectCall(new Error(JSON.stringify(message.error))) : resolveCall(message.result);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      rejectCall(new Error(`CDP websocket error for ${method}`));
    };
  });
}

async function closeAll() {
  pageTarget = null;
  cdpPort = null;
  if (appProcess && !appProcess.killed) appProcess.kill("SIGTERM");
  appProcess = null;
}

const server = new McpServer({ name: "ai-secretary-playwright-electron", version: "0.1.0" });

server.tool("electron_launch", "Launch the AI Secretary Electron app for real renderer testing.", {
  build: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(45_000),
  args: z.array(z.string()).default([]).describe("Extra CLI args passed after build/electron/main.cjs, e.g. ['--wait','1','--chat','hello']"),
  env: z.record(z.string(), z.string()).default({}).describe("Extra environment variables for the Electron app, e.g. AI_SECRETARY_AGENT_BACKEND=local-llama."),
}, async ({ build, timeoutMs, args, env }) => {
  if (appProcess && !appProcess.killed) return text({ launched: true, reused: true, target: pageTarget });
  if (!existsSync(electronExecutable())) throw new Error("Electron binary not found. Run bun install first.");
  if (build) await ensureBuild();
  cdpPort = 9333 + Math.floor(Math.random() * 1000);
  consoleMessages = [];
  appProcess = spawn(electronExecutable(), [`--remote-debugging-port=${cdpPort}`, builtMainPath(), ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      AI_SECRETARY_ROOT: projectRoot,
      AI_SECRETARY_LAUNCH_CWD: projectRoot,
      ELECTRON_OZONE_PLATFORM_HINT: process.env.XDG_SESSION_TYPE === "wayland" ? "wayland" : process.env.ELECTRON_OZONE_PLATFORM_HINT,
      WEBKIT_DISABLE_DMABUF_RENDERER: "1",
      LIBGL_ALWAYS_SOFTWARE: "1",
      MESA_LOADER_DRIVER_OVERRIDE: process.env.MESA_LOADER_DRIVER_OVERRIDE ?? "llvmpipe",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  appProcess.stdout?.on("data", (chunk) => {
    const msg = String(chunk);
    consoleMessages.push(msg);
    process.stderr.write(`[electron-app] ${msg}`);
  });
  appProcess.stderr?.on("data", (chunk) => {
    const msg = String(chunk);
    consoleMessages.push(msg);
    process.stderr.write(`[electron-app] ${msg}`);
  });
  appProcess.on("exit", () => { appProcess = null; });
  const target = await refreshPageTarget(timeoutMs);
  return text({ launched: true, cdpPort, target });
});

server.tool("electron_close", "Close the launched Electron app.", {}, async () => {
  await closeAll();
  return text({ closed: true });
});

server.tool("electron_window_info", "Return title and URL for the current Electron renderer target.", {}, async () => {
  return text(await refreshPageTarget());
});

server.tool("electron_screenshot", "Capture a screenshot of the Electron renderer via CDP.", {
  path: z.string().default("artifacts/electron-mcp-screenshot.png"),
}, async ({ path }) => {
  const result = await cdpCall("Page.captureScreenshot", { format: "png", fromSurface: true }, 15_000) as { data: string };
  const outPath = resolve(projectRoot, path);
  await mkdir(resolve(outPath, ".."), { recursive: true }).catch(() => undefined);
  await writeFile(outPath, Buffer.from(result.data, "base64"));
  return text({ path: outPath });
});

server.tool("electron_eval_renderer", "Evaluate JavaScript in the Electron renderer page.", { script: z.string() }, async ({ script }) => {
  const result = await cdpCall("Runtime.evaluate", { expression: script, awaitPromise: true, returnByValue: true }, 15_000);
  return text(result?.result?.value ?? result?.result ?? result);
});

server.tool("electron_console_messages", "Return captured Electron stdout/stderr messages.", {}, async () => text(consoleMessages.slice(-200)));

server.tool("electron_key", "Press a key in the Electron renderer via CDP Input.dispatchKeyEvent.", { key: z.string() }, async ({ key }) => {
  await cdpCall("Input.dispatchKeyEvent", { type: "keyDown", key });
  await cdpCall("Input.dispatchKeyEvent", { type: "keyUp", key });
  return text({ pressed: key });
});

server.tool("electron_type", "Type text into the focused element using DOM document.execCommand insertText.", { text: z.string() }, async ({ text: value }) => {
  await cdpCall("Runtime.evaluate", { expression: `document.execCommand('insertText', false, ${JSON.stringify(value)})`, awaitPromise: true });
  return text({ typed: value.length });
});

server.tool("electron_click", "Click a selector in the Electron renderer using DOM click().", { selector: z.string() }, async ({ selector }) => {
  await cdpCall("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})?.click()`, awaitPromise: true });
  return text({ clicked: selector });
});

server.tool("electron_eval_main", "Unavailable in CDP mode; use electron_eval_renderer.", { script: z.string() }, async () => {
  throw new Error("electron_eval_main is unavailable in CDP mode; use electron_eval_renderer.");
});

process.on("SIGINT", () => void closeAll().finally(() => process.exit(0)));
process.on("SIGTERM", () => void closeAll().finally(() => process.exit(0)));
process.on("exit", () => { if (appProcess && !appProcess.killed) appProcess.kill(); });

await server.connect(new StdioServerTransport());
