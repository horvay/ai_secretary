import { app, BrowserWindow, ipcMain, screen } from "electron";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "child_process";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

app.setName("AI Secretary");
app.commandLine.appendSwitch("class", "ai-secretary");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-software-rasterizer", "false");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("disable-gpu-rasterization");
app.commandLine.appendSwitch("disable-features", "Vulkan,UseSkiaRenderer,VaapiVideoDecoder,CanvasOopRasterization");
if (process.env.XDG_SESSION_TYPE === "wayland") {
  app.commandLine.appendSwitch("enable-features", "UseOzonePlatform");
  app.commandLine.appendSwitch("ozone-platform", "wayland");
}

const backendPort = Number(process.env.AI_SECRETARY_ELECTRON_BACKEND_PORT ?? String(52000 + Math.floor(Math.random() * 10000)));
let mainWindow: BrowserWindow | null = null;
let backend: ChildProcessWithoutNullStreams | null = null;
let ws: WebSocket | null = null;
let nextRequestId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();

type CompanionCorner = "bottom-right" | "bottom-left" | "top-right" | "top-left";
type CompanionPlacement = {
  monitorId: number | "primary";
  corner: CompanionCorner;
};

const defaultPlacement: CompanionPlacement = { monitorId: "primary", corner: "bottom-right" };
const companionSizes = {
  expanded: { width: 430, height: 560 },
  collapsed: { width: 280, height: 390 },
};
let companionExpanded = true;

function getPlacementPath() {
  return path.join(app.getPath("userData"), "companion-placement.json");
}

function loadCompanionPlacement(): CompanionPlacement {
  try {
    const parsed = JSON.parse(fs.readFileSync(getPlacementPath(), "utf8")) as Partial<CompanionPlacement>;
    const validCorners: CompanionCorner[] = ["bottom-right", "bottom-left", "top-right", "top-left"];
    return {
      monitorId: typeof parsed.monitorId === "number" ? parsed.monitorId : "primary",
      corner: parsed.corner && validCorners.includes(parsed.corner) ? parsed.corner : defaultPlacement.corner,
    };
  } catch {
    return defaultPlacement;
  }
}

function saveCompanionPlacement(placement: CompanionPlacement) {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(getPlacementPath(), JSON.stringify(placement, null, 2));
}

function getPlacementDisplays() {
  return screen.getAllDisplays().map((display, index) => ({
    id: display.id,
    index,
    label: `Monitor ${index + 1} (${display.workArea.width}×${display.workArea.height})`,
    primary: display.id === screen.getPrimaryDisplay().id,
  }));
}

function applyCompanionPlacement(placement = loadCompanionPlacement()) {
  if (!mainWindow) return;
  const bounds = getCompanionBounds(placement);
  // Do not ask Electron/WM to animate this resize. When the companion expands
  // or collapses, its x/y and width/height change together to preserve the
  // chosen corner. Native bounds animation interpolates those values and makes
  // Ari appear to bounce around before landing back in place.
  mainWindow.setBounds(bounds, false);
  applyHyprlandFloatingFix();
}

function setCompanionExpanded(expanded: boolean) {
  if (companionExpanded === expanded && mainWindow) return;
  companionExpanded = expanded;
  if (!mainWindow) return;
  mainWindow.webContents.send("rpc-send:setCompanionExpanded", { expanded });
  applyCompanionPlacement();
}

function writeProcessStream(stream: NodeJS.WriteStream, chunk: Buffer) {
  if (stream.destroyed || stream.writableEnded) return;
  try {
    stream.write(chunk);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPIPE") {
      throw error;
    }
  }
}

function startBackend() {
  const backendPath = path.join(process.cwd(), "build", "electron", "backend.js");
  backend = spawn("bun", [backendPath, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: { ...process.env, AI_SECRETARY_ELECTRON_BACKEND_PORT: String(backendPort) },
  });
  backend.stdout.on("data", (chunk) => writeProcessStream(process.stdout, chunk));
  backend.stderr.on("data", (chunk) => writeProcessStream(process.stderr, chunk));
  backend.on("exit", (code, signal) => console.log(`[electron] backend exited code=${code} signal=${signal}`));
}

function connectBackend(): Promise<void> {
  return new Promise((resolve) => {
    ws = new WebSocket(`ws://127.0.0.1:${backendPort}/ws`);
    ws.onopen = () => resolve();
    ws.onmessage = (event) => {
    const packet = JSON.parse(String(event.data)) as { type: string; id?: number; name?: string; payload?: unknown; result?: unknown; error?: string };
    if (packet.type === "response" && packet.id != null) {
      const entry = pending.get(packet.id);
      if (!entry) return;
      pending.delete(packet.id);
      packet.error ? entry.reject(new Error(packet.error)) : entry.resolve(packet.result);
    } else if (packet.type === "send" && packet.name) {
      if (["showResponse", "setState", "setOverrideState"].includes(packet.name)) {
        console.log(`[electron-main] forward send ${packet.name}`);
      }
      mainWindow?.webContents.send(`rpc-send:${packet.name}`, packet.payload ?? {});
    } else if (packet.type === "request-renderer" && packet.id != null && packet.name) {
      mainWindow?.webContents.send(`rpc-request-renderer:${packet.name}`, { id: packet.id, payload: packet.payload ?? {} });
    }
  };
    ws.onclose = () => setTimeout(() => void connectBackend(), 500);
    ws.onerror = () => ws?.close();
  });
}

function requestBackend(name: string, payload: unknown) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error("Backend websocket is not connected"));
      return;
    }
    const id = nextRequestId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: "request", id, name, payload: payload ?? {} }));
  });
}

function sendBackend(name: string, payload: unknown) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "message", name, payload: payload ?? {} }));
}

type HyprlandClient = {
  address?: string;
  class?: string;
  title?: string;
  pid?: number;
};

function findHyprlandWindowMatcher() {
  try {
    const clientsResult = spawnSync("hyprctl", ["clients", "-j"], { encoding: "utf8" });
    if (clientsResult.status !== 0) return "title:AI Secretary";

    const clients = JSON.parse(clientsResult.stdout) as HyprlandClient[];
    const currentPid = process.pid;
    const client = clients.find((entry) => entry.pid === currentPid)
      ?? clients.find((entry) => entry.title === "AI Secretary" && entry.class === "electron" && entry.pid === currentPid)
      ?? clients.find((entry) => entry.title === "AI Secretary" && entry.class === "electron")
      ?? clients.find((entry) => entry.title === "AI Secretary");

    return client?.address ? `address:${client.address}` : "title:AI Secretary";
  } catch (error) {
    console.warn("[electron] hyprctl client lookup failed:", error);
    return "title:AI Secretary";
  }
}

function applyHyprlandFloatingFix() {
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE || !mainWindow) return;

  const bounds = getCompanionBounds(loadCompanionPlacement());
  mainWindow.setBounds(bounds, false);

  const matcher = findHyprlandWindowMatcher();
  const batch = [
    `dispatch setfloating ${matcher}`,
    `dispatch resizewindowpixel exact ${bounds.width} ${bounds.height},${matcher}`,
    `dispatch movewindowpixel exact ${bounds.x} ${bounds.y},${matcher}`,
  ].join("; ");

  try {
    const result = spawnSync("hyprctl", ["--batch", batch], { encoding: "utf8" });
    if (result.status !== 0) console.warn("[electron] hyprctl floating fix failed:", result.stderr || result.stdout);

    const decorationRules = [
      "no_blur on, match:title ^(AI Secretary)$",
      "border_size 0, match:title ^(AI Secretary)$",
      "no_follow_mouse on, match:title ^(AI Secretary)$",
      "no_anim on, match:title ^(AI Secretary)$",
    ];
    for (const rule of decorationRules) {
      const ruleResult = spawnSync("hyprctl", ["keyword", "windowrule", rule], { encoding: "utf8" });
      if (ruleResult.status !== 0) console.warn(`[electron] hyprctl decoration rule failed (${rule}):`, ruleResult.stderr || ruleResult.stdout);
    }

    mainWindow.setBounds(bounds, false);
  } catch (error) {
    console.warn("[electron] hyprctl floating fix unavailable:", error);
  }
}

ipcMain.handle("rpc-request", (_event, { name, payload }: { name: string; payload: unknown }) => {
  if (name === "getCompanionPlacement") {
    return { placement: loadCompanionPlacement(), displays: getPlacementDisplays() };
  }
  if (name === "setCompanionExpanded") {
    setCompanionExpanded(Boolean((payload as { expanded?: boolean } | undefined)?.expanded));
    return { expanded: companionExpanded };
  }
  if (name === "setCompanionPlacement") {
    const next = payload as Partial<CompanionPlacement>;
    const placement: CompanionPlacement = {
      monitorId: typeof next.monitorId === "number" ? next.monitorId : "primary",
      corner: next.corner ?? defaultPlacement.corner,
    };
    saveCompanionPlacement(placement);
    applyCompanionPlacement(placement);
    return { placement, displays: getPlacementDisplays() };
  }
  return requestBackend(name, payload);
});
ipcMain.on("rpc-message", (_event, { name, payload }: { name: string; payload: unknown }) => sendBackend(name, payload));
ipcMain.on("rpc-renderer-response", (_event, packet: { id: number; result?: unknown; error?: string }) => {
  ws?.send(JSON.stringify({ type: "renderer-response", ...packet }));
});

function getCompanionBounds(placement = loadCompanionPlacement()) {
  const displays = screen.getAllDisplays();
  const display = displays.find((entry) => entry.id === placement.monitorId) ?? screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;
  const { width: windowWidth, height: windowHeight } = companionExpanded ? companionSizes.expanded : companionSizes.collapsed;
  const margin = 18;
  const isRight = placement.corner.endsWith("right");
  const isBottom = placement.corner.startsWith("bottom");

  return {
    width: windowWidth,
    height: windowHeight,
    x: isRight ? x + width - windowWidth - margin : x + margin,
    y: isBottom ? y + height - windowHeight - margin : y + margin,
  };
}

async function createWindow() {
  const companionBounds = getCompanionBounds();

  mainWindow = new BrowserWindow({
    title: "AI Secretary",
    ...companionBounds,
    frame: false,
    resizable: false,
    show: false,
    alwaysOnTop: true,
    transparent: true,
    hasShadow: false,
    skipTaskbar: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(process.cwd(), "build", "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.webContents.on("console-message", (_event, _level, message) => {
    if (message.includes("[renderer-rpc]") || message.includes("[voice-preload]")) console.log(message);
  });

  mainWindow.once("ready-to-show", () => {
    if (!mainWindow) return;
    mainWindow.showInactive();
    applyHyprlandFloatingFix();
    setTimeout(applyHyprlandFloatingFix, 250);
    setTimeout(applyHyprlandFloatingFix, 1000);
  });

  await mainWindow.loadURL(pathToFileURL(path.join(process.cwd(), "build", "electron", "avatar", "index.html")).toString());

  const screenshotPath = process.env.AI_SECRETARY_TAKE_SCREENSHOT;
  if (screenshotPath) {
    const screenshotDelayMs = Number(process.env.AI_SECRETARY_SCREENSHOT_DELAY_MS ?? 5000);
    setTimeout(async () => {
      try {
        const image = await mainWindow?.webContents.capturePage();
        if (image) await import("fs/promises").then((fs) => fs.writeFile(screenshotPath, image.toPNG()));
        console.log(`[electron] captured window screenshot: ${screenshotPath}`);
      } catch (error) {
        console.error("[electron] screenshot failed:", error);
      }
    }, Number.isFinite(screenshotDelayMs) ? screenshotDelayMs : 5000);
  }
}

app.whenReady().then(async () => {
  startBackend();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await connectBackend();
  await createWindow();
});

app.on("window-all-closed", () => app.quit());
function stopBackend() {
  try {
    backend?.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  backend = null;
}

app.on("before-quit", stopBackend);
process.on("SIGINT", () => {
  stopBackend();
  app.quit();
});
process.on("SIGTERM", () => {
  stopBackend();
  app.quit();
});
