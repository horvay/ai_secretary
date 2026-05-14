/**
 * Screenshot Capture Service
 * Pure functions for capturing screenshots of the active window or full screen
 */

import { Monitor, Window } from "node-screenshots";
import { execFileSync, execSync } from "child_process";

// Dynamic import for active-win (ESM module)
let activeWindowFn: (() => Promise<ActiveWindowResult | undefined>) | null = null;

interface ActiveWindowResult {
  id?: number;
  title?: string;
  owner?: {
    name: string;
  };
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * Fallback function to get active window ID on Linux using xprop directly.
 * This is used when active-win fails (e.g., xwininfo not installed).
 */
function getActiveWindowIdLinux(): number | null {
  try {
    // Get active window ID using xprop
    // Output format: "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x740a803"
    const result = execSync('xprop -root _NET_ACTIVE_WINDOW', {
      encoding: 'utf8',
      timeout: 1000,
    });

    // Parse the output to get the hex window ID
    const match = result.match(/window id # (0x[0-9a-fA-F]+)/);
    if (match) {
      const windowId = parseInt(match[1], 16);
      // ID 0 means no active window
      if (windowId === 0) {
        return null;
      }
      return windowId;
    }
    return null;
  } catch (error) {
    console.warn("xprop fallback failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Try xdotool as another fallback for getting active window ID
 */
function getActiveWindowIdXdotool(): number | null {
  try {
    const result = execSync('xdotool getactivewindow', {
      encoding: 'utf8',
      timeout: 1000,
    });
    const id = parseInt(result.trim(), 10);
    return isNaN(id) ? null : id;
  } catch (error) {
    return null;
  }
}

async function getActiveWindow(): Promise<ActiveWindowResult | undefined> {
  // First try active-win (may fail if xwininfo not installed)
  try {
    if (!activeWindowFn) {
      const module = await import("active-win");
      activeWindowFn = module.activeWindow;
    }
    const result = await activeWindowFn();
    if (result && result.id) {
      return result;
    }
  } catch (error) {
    // active-win failed, try fallbacks
    console.warn("active-win failed, trying fallbacks:", error instanceof Error ? error.message : error);
  }

  // Linux-only fallbacks (xprop/xdotool)
  if (process.platform === "linux") {
    // Fallback 1: Use xprop directly
    let windowId = getActiveWindowIdLinux();
    if (windowId) {
      console.log(`Got active window ID via xprop: ${windowId}`);
      return { id: windowId };
    }

    // Fallback 2: Use xdotool
    windowId = getActiveWindowIdXdotool();
    if (windowId) {
      console.log(`Got active window ID via xdotool: ${windowId}`);
      return { id: windowId };
    }
  }

  return undefined;
}

export interface ScreenshotOptions {
  activeWindowOnly?: boolean;
  format?: "png" | "jpg";
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface HyprlandActiveWindow {
  at?: [number, number];
  size?: [number, number];
  class?: string;
  title?: string;
  stableId?: string;
}

function bufferToPngDataUrl(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

function isWaylandSession(): boolean {
  return process.platform === "linux" && Boolean(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland");
}

function isHyprlandSession(): boolean {
  if (process.platform !== "linux") {
    return false;
  }

  const currentDesktop = process.env.XDG_CURRENT_DESKTOP?.toLowerCase() ?? "";
  return Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE || currentDesktop.includes("hyprland"));
}

function getHyprlandActiveWindow(): HyprlandActiveWindow | null {
  if (!isHyprlandSession()) {
    return null;
  }

  try {
    const output = execFileSync("hyprctl", ["-j", "activewindow"], {
      encoding: "utf8",
      timeout: 1000,
    });
    const activeWindow = JSON.parse(output) as HyprlandActiveWindow;
    if (!activeWindow || Object.keys(activeWindow).length === 0) {
      return null;
    }
    return activeWindow;
  } catch (error) {
    console.warn("[Screenshot] Hyprland activewindow lookup failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

function capturePortalScreenshot(): string | null {
  if (!isWaylandSession()) {
    return null;
  }

  try {
    console.log("[Screenshot] Trying xdg-desktop-portal screenshot capture");
    const script = String.raw`
import dbus
import dbus.mainloop.glib
from gi.repository import GLib
from urllib.parse import urlparse, unquote
from pathlib import Path
import sys
import time

dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
bus = dbus.SessionBus()
unique = bus.get_connection().get_unique_name()[1:].replace('.', '_')
token = f'ari_screenshot_{int(time.time() * 1000)}'
request_path = f'/org/freedesktop/portal/desktop/request/{unique}/{token}'
loop = GLib.MainLoop()
state = {'done': False, 'path': ''}

def response_handler(response, results):
    state['done'] = True
    if int(response) == 0 and 'uri' in results:
        uri = str(results['uri'])
        parsed = urlparse(uri)
        if parsed.scheme == 'file':
            path = Path(unquote(parsed.path))
            if path.exists():
                state['path'] = str(path)
    loop.quit()

bus.add_signal_receiver(
    response_handler,
    dbus_interface='org.freedesktop.portal.Request',
    signal_name='Response',
    path=request_path,
)

desktop = bus.get_object('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop')
screenshot = dbus.Interface(desktop, 'org.freedesktop.portal.Screenshot')
screenshot.Screenshot('', {
    'handle_token': dbus.String(token),
    'interactive': dbus.Boolean(False),
})
GLib.timeout_add_seconds(30, lambda: (loop.quit(), False)[-1])
loop.run()

if not state['path']:
    sys.exit(2)
print(state['path'])
`;
    const imagePath = execFileSync("python", ["-c", script], {
      encoding: "utf8",
      timeout: 35_000,
      maxBuffer: 1024 * 1024,
    }).trim();
    const buffer = execFileSync("python", ["-c", `from pathlib import Path; import sys; sys.stdout.buffer.write(Path(${JSON.stringify(imagePath)}).read_bytes())`], {
      encoding: "buffer",
      timeout: 3000,
      maxBuffer: 50 * 1024 * 1024,
    });
    console.log(`[Screenshot] ✅ xdg-desktop-portal capture succeeded (${buffer.length} bytes)`);
    return bufferToPngDataUrl(buffer);
  } catch (error) {
    console.warn("[Screenshot] xdg-desktop-portal capture failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

function captureHyprlandActiveWindow(): string | null {
  const activeWindow = getHyprlandActiveWindow();
  if (!activeWindow) {
    return null;
  }

  const label = `${activeWindow.class ?? "unknown"}: ${activeWindow.title ?? "unknown"}`;

  if (activeWindow.stableId) {
    try {
      console.log(`[Screenshot] Trying Hyprland toplevel capture via grim -T for ${label}`);
      const buffer = execFileSync("grim", ["-T", activeWindow.stableId, "-"], {
        encoding: "buffer",
        timeout: 3000,
        maxBuffer: 25 * 1024 * 1024,
      });
      console.log(`[Screenshot] ✅ Hyprland toplevel capture succeeded (${buffer.length} bytes)`);
      return bufferToPngDataUrl(buffer);
    } catch (error) {
      console.warn("[Screenshot] Hyprland toplevel capture failed, trying geometry capture:", error instanceof Error ? error.message : error);
    }
  }

  if (activeWindow.at && activeWindow.size) {
    const [x, y] = activeWindow.at;
    const [width, height] = activeWindow.size;
    if (width > 0 && height > 0) {
      try {
        const geometry = `${x},${y} ${width}x${height}`;
        console.log(`[Screenshot] Trying Hyprland geometry capture via grim -g ${geometry} for ${label}`);
        const buffer = execFileSync("grim", ["-g", geometry, "-"], {
          encoding: "buffer",
          timeout: 3000,
          maxBuffer: 25 * 1024 * 1024,
        });
        console.log(`[Screenshot] ✅ Hyprland geometry capture succeeded (${buffer.length} bytes)`);
        return bufferToPngDataUrl(buffer);
      } catch (error) {
        console.warn("[Screenshot] Hyprland geometry capture failed:", error instanceof Error ? error.message : error);
      }
    }
  }

  return null;
}

/**
 * Capture full screen screenshot
 */
export async function captureScreen(options: ScreenshotOptions = {}): Promise<string> {
  try {
    const format = options.format || "png";

    if (format === "png") {
      const portalScreenshot = capturePortalScreenshot();
      if (portalScreenshot) {
        return portalScreenshot;
      }
    }

    // Get all monitors and use the primary one, or first one if no primary
    const monitors = Monitor.all();
    if (monitors.length === 0) {
      throw new Error("No monitors found");
    }

    // Find primary monitor, or use first one
    const monitor = monitors.find((m) => m.isPrimary) || monitors[0];

    // Capture image from monitor
    const image = await monitor.captureImage();

    // Convert to buffer based on format
    let buffer: Buffer;
    if (format === "jpg") {
      buffer = await image.toJpeg();
    } else {
      buffer = await image.toPng();
    }

    const base64 = buffer.toString("base64");
    return `data:image/${format};base64,${base64}`;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`Screenshot capture failed: ${errorMsg}`);
  }
}

/**
 * Get active window bounds
 */
export async function getActiveWindowBounds(): Promise<WindowBounds | null> {
  try {
    const win = await getActiveWindow();
    if (!win || !win.bounds) {
      return null;
    }
    return {
      x: win.bounds.x,
      y: win.bounds.y,
      width: win.bounds.width,
      height: win.bounds.height,
    };
  } catch (error) {
    // active-win may fail on Linux if package.json is not found in build directory
    // This is a known limitation - gracefully fall back to full screen
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes("package.json") || errorMsg.includes("ENOENT")) {
      console.warn("Active window detection unavailable (package.json not found in build directory)");
    } else {
      console.warn("Failed to get active window bounds:", errorMsg);
    }
    return null;
  }
}

/**
 * Capture active window screenshot
 * Falls back to full screen if active window detection fails
 */
export async function captureActiveWindow(): Promise<string> {
  try {
    console.log("[Screenshot] Attempting to capture active window...");

    const hyprlandScreenshot = captureHyprlandActiveWindow();
    if (hyprlandScreenshot) {
      return hyprlandScreenshot;
    }

    if (isWaylandSession()) {
      const portalScreenshot = capturePortalScreenshot();
      if (portalScreenshot) {
        console.log("[Screenshot] Using portal screenshot for Wayland active-window request; capture may be full-screen/user-mediated");
        return portalScreenshot;
      }
    }

    // Get active window info
    const activeWin = await getActiveWindow();

    if (!activeWin || !activeWin.id) {
      console.warn("[Screenshot] Could not get active window info, trying AI Secretary window fallback");
      const appWindow = Window.all().find((w) =>
        w.width > 0 &&
        w.height > 0 &&
        /AI Secretary|index\.html|avatar/i.test(w.title ?? "")
      );
      if (appWindow) {
        console.log(`[Screenshot] ✅ Capturing fallback app window: "${appWindow.title}" (${appWindow.width}x${appWindow.height})`);
        const image = await appWindow.captureImage();
        const buffer = await image.toPng();
        return bufferToPngDataUrl(buffer);
      }
      console.warn("[Screenshot] Could not find AI Secretary window fallback, returning full screenshot");
      return captureScreen();
    }

    console.log(`[Screenshot] Active window ID: ${activeWin.id}, title: "${activeWin.title || 'unknown'}"`);

    // Get all windows from node-screenshots
    const windows = Window.all();
    console.log(`[Screenshot] Found ${windows.length} windows via node-screenshots`);

    // Find the window matching the active window ID
    const window = windows.find((w) => w.id === activeWin.id);

    if (!window) {
      console.warn(`[Screenshot] Could not find window with ID ${activeWin.id} in node-screenshots list`);
      console.log(`[Screenshot] Available window IDs: ${windows.map(w => `${w.id} ("${w.title}")`).join(", ")}`);
      return captureScreen();
    }

    // Validate window dimensions
    if (window.width <= 0 || window.height <= 0) {
      console.warn(`[Screenshot] Invalid window dimensions: ${window.width}x${window.height}, returning full screenshot`);
      return captureScreen();
    }

    console.log(`[Screenshot] ✅ Capturing window: "${window.title}" (${window.width}x${window.height})`);

    // Capture the window directly
    const image = await window.captureImage();
    const buffer = await image.toPng();

    console.log(`[Screenshot] ✅ Active window captured successfully (${buffer.length} bytes)`);
    return bufferToPngDataUrl(buffer);
  } catch (error) {
    console.error("[Screenshot] Active window capture failed, falling back to full screen:", error);
    return captureScreen();
  }
}

// Legacy export for backwards compatibility
export const screenshotService = {
  capture: captureScreen,
  captureActiveWindow,
  getActiveWindowBounds,
};
