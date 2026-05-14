import { parseCliArgs } from "../bun/cli";
import { logInfo, logError } from "../bun/utils/logger";
import { piperTTS } from "../bun/services/piper";
import { triggerManualCheck } from "../bun/services/routineScheduler";
import { createBackendApp } from "../bun/app/backendApp";
import { createMessageHandlers, createRequestHandlers } from "../bun/rpc/handlers";
import type { AISecretaryRPC } from "../shared/rpc";

const cliArgs = parseCliArgs();
let socket: ServerWebSocket<unknown> | null = null;
let isWebviewReady = false;
let nextRequestId = 1;
const pendingRendererRequests = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();

function summarizeRpcValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") return value.length > 240 ? `${value.slice(0, 240)}… (${value.length} chars)` : value;
  if (value instanceof ArrayBuffer) return `<ArrayBuffer ${value.byteLength} bytes>`;
  if (ArrayBuffer.isView(value)) return `<${value.constructor.name} ${value.byteLength} bytes>`;
  if (Array.isArray(value)) return value.length > 8 ? [...value.slice(0, 8).map(summarizeRpcValue), `… ${value.length - 8} more`] : value.map(summarizeRpcValue);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "data" || key === "base64" || key === "audioData") && typeof child === "string" && child.length > 1024) out[key] = `<base64 ${child.length} chars>`;
      else out[key] = summarizeRpcValue(child);
    }
    return out;
  }
  return value;
}

function sendPacket(packet: Record<string, unknown>) {
  socket?.send(JSON.stringify(packet));
}

const rpc = {
  send: new Proxy({}, {
    get(_target, prop: string) {
      return (payload: unknown) => sendPacket({ type: "send", name: prop, payload: payload ?? {} });
    },
  }),
  request: new Proxy({}, {
    get(_target, prop: string) {
      return (payload: unknown) => new Promise((resolve, reject) => {
        const id = nextRequestId++;
        pendingRendererRequests.set(id, { resolve, reject });
        sendPacket({ type: "request-renderer", id, name: prop, payload: payload ?? {} });
      });
    },
  }),
} as unknown as {
  send: AISecretaryRPC["webview"]["messages"];
  request: AISecretaryRPC["webview"]["requests"];
};

const backendApp = createBackendApp({
  rpc,
  cliArgs,
  isWebviewReady: () => isWebviewReady,
});

const requestHandlers = createRequestHandlers({
  piperTTS,
  getAgentClient: backendApp.getAgentClient,
  getRpc: () => rpc as never,
  onWebviewReady: () => {
    isWebviewReady = true;
    logInfo("🔌 Electron renderer ready");
    setTimeout(() => {
      rpc.send.logMessage({ level: "info", message: "AI Secretary loaded successfully!" });
      rpc.send.setState({ state: "idle" });
      if (cliArgs.chatMessage || cliArgs.reconcileProfile || cliArgs.checkReminders || cliArgs.openModal || cliArgs.openSettings || cliArgs.takeScreenshot || cliArgs.injectContext || cliArgs.testSilent || cliArgs.testInterruptSeconds || cliArgs.testRapidQuestions || cliArgs.testInterruptThenChat) {
        rpc.send.initWithCliArgs({ ...cliArgs });
      }
    }, 500);
  },
});
const messageHandlers = createMessageHandlers();
const wrappedRequestHandlers = {
  ...requestHandlers,
  checkRoutineReminders: async () => {
    const result = await triggerManualCheck();
    return { hasPending: result.triggered, routineNames: result.routineNames };
  },
};

const server = Bun.serve({
  port: Number(process.env.AI_SECRETARY_ELECTRON_BACKEND_PORT ?? 51234),
  fetch(req, server) {
    if (new URL(req.url).pathname === "/ws") {
      return server.upgrade(req) ? undefined : new Response("Upgrade failed", { status: 500 });
    }
    return new Response("AI Secretary Electron backend");
  },
  websocket: {
    open(ws) {
      socket = ws;
      logInfo("🔌 Electron frontend connected");
    },
    close() {
      socket = null;
      isWebviewReady = false;
    },
    async message(_ws, raw) {
      const packet = JSON.parse(String(raw)) as { type: string; id?: number; name?: string; payload?: unknown; result?: unknown; error?: string };
      if (packet.type === "request") {
        console.log(`[backend-rpc] request ${String(packet.name)}`, summarizeRpcValue(packet.payload ?? {}));
        const handler = (wrappedRequestHandlers as Record<string, (payload: unknown) => unknown>)[String(packet.name)];
        if (!handler) {
          sendPacket({ type: "response", id: packet.id, error: `Unknown RPC request: ${packet.name}` });
          return;
        }
        try {
          const result = await handler(packet.payload ?? {});
          console.log(`[backend-rpc] response ${String(packet.name)}`, summarizeRpcValue(result));
          sendPacket({ type: "response", id: packet.id, result });
        } catch (error) {
          sendPacket({ type: "response", id: packet.id, error: error instanceof Error ? error.message : String(error) });
        }
      } else if (packet.type === "message") {
        console.log(`[backend-rpc] message ${String(packet.name)}`, summarizeRpcValue(packet.payload ?? {}));
        const handler = (messageHandlers as Record<string, (payload: unknown) => void>)[String(packet.name)];
        handler?.(packet.payload ?? {});
      } else if (packet.type === "renderer-response" && packet.id != null) {
        const pending = pendingRendererRequests.get(packet.id);
        if (!pending) return;
        pendingRendererRequests.delete(packet.id);
        packet.error ? pending.reject(new Error(packet.error)) : pending.resolve(packet.result);
      }
    },
  },
});

process.on("SIGTERM", () => backendApp.shutdown(server).finally(() => process.exit(0)));
process.on("SIGINT", () => backendApp.shutdown(server).finally(() => process.exit(0)));

logInfo(`🔌 Electron backend listening on ${server.url}`);
backendApp.initialize().catch((error) => logError("❌ Backend init failed:", error));
