#!/usr/bin/env bun
/**
 * Capture Screenshot Tool for Ari
 *
 * Captures the active window, extracts text via OCR, and saves to memory.
 * Run this tool when you need to see what's on the user's screen.
 *
 * Usage:
 *   bun resources/tools/capture-screenshot.ts
 *   bun resources/tools/capture-screenshot.ts --fullscreen
 *   bun resources/tools/capture-screenshot.ts --no-ocr
 *
 * Options:
 *   --fullscreen    Capture the entire screen instead of active window
 *   --no-ocr        Skip OCR text extraction (faster)
 */

import { Database } from "bun:sqlite";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { Monitor, Window } from "node-screenshots";
import { createWorker, type Worker } from "tesseract.js";
import { homedir } from "os";

function getDataDir(): string {
  const override = process.env.AI_SECRETARY_DATA_DIR?.trim();
  if (override) return override;
  if (process.platform === "win32" && process.env.LOCALAPPDATA?.trim()) {
    return join(process.env.LOCALAPPDATA, ".ai-secretary");
  }
  return join(homedir(), ".ai-secretary");
}

// ============================================================================
// Path Helpers
// ============================================================================

/**
 * Find the memory database path
 */
function findDbPath(): string {
  return join(getDataDir(), "memory", "memory.db");
}

/**
 * Find the screenshots directory
 */
function findScreenshotsDir(): string {
  return join(getDataDir(), "memory", "screenshots");
}

const DB_PATH = findDbPath();
const SCREENSHOTS_DIR = findScreenshotsDir();

function getDb(): Database {
  if (!existsSync(DB_PATH)) {
    console.log(`Error: Database not found at ${DB_PATH}`);
    console.log("The memory database has not been created yet. Start the AI Secretary app first.");
    process.exit(1);
  }
  return new Database(DB_PATH);
}

// ============================================================================
// Active Window Detection
// ============================================================================

interface ActiveWindowResult {
  id?: number;
  title?: string;
  owner?: {
    name?: string;
  };
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

let activeWindowFn: (() => Promise<ActiveWindowResult | undefined>) | null = null;

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

  return undefined;
}

// ============================================================================
// Screenshot Capture
// ============================================================================

interface CaptureResult {
  buffer: Buffer;
  width: number;
  height: number;
  windowTitle?: string;
  windowApp?: string;
}

/**
 * Capture the full screen
 */
async function captureFullScreen(): Promise<CaptureResult> {
  const monitors = Monitor.all();
  if (monitors.length === 0) {
    throw new Error("No monitors found");
  }

  const monitor = monitors.find((m) => m.isPrimary) || monitors[0];
  const image = await monitor.captureImage();
  const buffer = await image.toPng();

  return {
    buffer,
    width: monitor.width,
    height: monitor.height,
  };
}

/**
 * Capture the active window
 */
async function captureActiveWindow(): Promise<CaptureResult> {
  try {
    const activeWin = await getActiveWindow();

    if (!activeWin || !activeWin.id) {
      console.warn("Could not get active window info, falling back to full screen");
      return captureFullScreen();
    }

    console.log(`Active window ID: ${activeWin.id}, title: "${activeWin.title || 'unknown'}"`);

    const windows = Window.all();
    console.log(`Found ${windows.length} windows via node-screenshots`);

    const window = windows.find((w) => w.id === activeWin.id);

    if (!window) {
      console.warn(`Could not find window with ID ${activeWin.id} in node-screenshots list`);
      console.log(`Available window IDs: ${windows.map(w => `${w.id} ("${w.title}")`).join(", ")}`);
      return captureFullScreen();
    }

    if (window.width <= 0 || window.height <= 0) {
      console.warn(`Invalid window dimensions: ${window.width}x${window.height}, falling back to full screen`);
      return captureFullScreen();
    }

    console.log(`Capturing window: "${window.title}" (${window.width}x${window.height})`);

    const image = await window.captureImage();
    const buffer = await image.toPng();

    return {
      buffer,
      width: window.width,
      height: window.height,
      windowTitle: activeWin.title || window.title,
      windowApp: activeWin.owner?.name || window.appName,
    };
  } catch (error) {
    console.log("Active window capture failed, falling back to full screen:", error);
    return captureFullScreen();
  }
}

// ============================================================================
// OCR
// ============================================================================

let ocrWorker: Worker | null = null;

/**
 * Initialize Tesseract worker
 */
async function initOcr(): Promise<Worker> {
  if (!ocrWorker) {
    console.log("Initializing OCR engine...");
    ocrWorker = await createWorker("eng");
    console.log("OCR engine ready.");
  }
  return ocrWorker;
}

/**
 * Extract text from image buffer
 */
async function extractText(imageBuffer: Buffer): Promise<string> {
  const worker = await initOcr();
  const result = await worker.recognize(imageBuffer);
  return result.data.text.trim();
}

/**
 * Shutdown OCR worker
 */
async function shutdownOcr(): Promise<void> {
  if (ocrWorker) {
    await ocrWorker.terminate();
    ocrWorker = null;
  }
}

// ============================================================================
// File & Database Operations
// ============================================================================

/**
 * Generate a unique screenshot filename
 */
function generateFilename(): string {
  const timestamp = Date.now();
  const hash = Math.random().toString(36).substring(2, 10);
  return `screenshot_image_${timestamp}-${hash}.png`;
}

/**
 * Save screenshot to file and database
 */
function readAppStateBoolean(db: Database, key: string, fallback: boolean): boolean {
  try {
    const row = db.query("SELECT value FROM app_state WHERE key = ?").get(key) as { value?: string } | null;
    if (!row?.value) return fallback;
    try {
      const parsed = JSON.parse(row.value);
      return typeof parsed === "boolean" ? parsed : fallback;
    } catch {
      const lower = row.value.trim().toLowerCase();
      if (lower === "1" || lower === "true") return true;
      if (lower === "0" || lower === "false") return false;
      return fallback;
    }
  } catch {
    return fallback;
  }
}

function saveScreenshot(params: {
  buffer: Buffer;
  filename: string;
  ocrText: string;
  width: number;
  height: number;
  windowTitle?: string;
  windowApp?: string;
}): number {
  const db = getDb();
  const memoryEnabled = readAppStateBoolean(db, "memory.enabled", true);
  const screenshotLoggingEnabled = readAppStateBoolean(db, "memory.screenshotLoggingEnabled", true);
  const ocrEnabled = readAppStateBoolean(db, "memory.ocrEnabled", true);

  if (!memoryEnabled || !screenshotLoggingEnabled) {
    db.close();
    throw new Error("Screenshot logging is disabled by current memory settings.");
  }

  // Ensure screenshots directory exists
  if (!existsSync(SCREENSHOTS_DIR)) {
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }

  // Save file
  const filePath = join(SCREENSHOTS_DIR, params.filename);
  Bun.write(filePath, params.buffer);

  // Save to database
  const metadata = JSON.stringify({
    windowTitle: params.windowTitle,
    windowApp: params.windowApp,
    capturedBy: "capture-screenshot-tool",
  });

  const result = db
    .query(
      `INSERT INTO screenshots (file_key, ocr_text, timestamp, width, height, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.filename,
      ocrEnabled ? params.ocrText || null : null,
      Date.now(),
      params.width,
      params.height,
      metadata
    );

  db.close();

  return Number(result.lastInsertRowid);
}

// ============================================================================
// CLI Interface
// ============================================================================

function parseArgs(): { fullscreen: boolean; noOcr: boolean } {
  const args = process.argv.slice(2);
  return {
    fullscreen: args.includes("--fullscreen") || args.includes("-f"),
    noOcr: args.includes("--no-ocr") || args.includes("-n"),
  };
}

function printHelp(): void {
  console.log(`
Capture Screenshot Tool for Ari

Captures the active window (or full screen), extracts text via OCR,
and saves to memory for future reference.

Usage:
  bun ./tools/capture-screenshot.ts [options]

Options:
  --fullscreen, -f    Capture the entire screen instead of active window
  --no-ocr, -n        Skip OCR text extraction (faster)
  --help, -h          Show this help message

Output:
  Returns the captured screenshot info including:
  - File path where the screenshot was saved
  - Timestamp of capture
  - Window title (if available)
  - Dimensions
  - Extracted OCR text (unless --no-ocr)

Example:
  # Capture active window with OCR
  bun ./tools/capture-screenshot.ts

  # Capture full screen without OCR (faster)
  bun ./tools/capture-screenshot.ts --fullscreen --no-ocr
`);
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  // Check for help
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const args = parseArgs();
  const startTime = Date.now();

  try {
    // Capture screenshot
    console.log(args.fullscreen ? "Capturing full screen..." : "Capturing active window...");
    const capture = args.fullscreen
      ? await captureFullScreen()
      : await captureActiveWindow();

    // Extract OCR text
    let ocrText = "";
    if (!args.noOcr) {
      console.log("Extracting text from screenshot...");
      ocrText = await extractText(capture.buffer);
    }

    // Generate filename and save
    const filename = generateFilename();
    const id = saveScreenshot({
      buffer: capture.buffer,
      filename,
      ocrText,
      width: capture.width,
      height: capture.height,
      windowTitle: capture.windowTitle,
      windowApp: capture.windowApp,
    });

    // Output results
    const duration = Date.now() - startTime;
    console.log("\n✅ Screenshot captured!");
    console.log(`   File: ${filename}`);
    console.log(`   Path: ${join(SCREENSHOTS_DIR, filename)}`);
    console.log(`   Time: ${formatTime(Date.now())}`);
    if (capture.windowTitle) {
      console.log(`   Window: "${capture.windowTitle}"`);
    }
    if (capture.windowApp) {
      console.log(`   App: ${capture.windowApp}`);
    }
    console.log(`   Size: ${capture.width}x${capture.height}`);
    console.log(`   Database ID: ${id}`);
    console.log(`   Duration: ${duration}ms`);

    if (ocrText) {
      console.log("\nOCR Text:");
      console.log("---");
      console.log(ocrText);
      console.log("---");
    } else if (args.noOcr) {
      console.log("\n(OCR skipped with --no-ocr flag)");
    } else {
      console.log("\n(No text detected in screenshot)");
    }
  } catch (error) {
    console.log("Error:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    await shutdownOcr();
  }
}

main();

