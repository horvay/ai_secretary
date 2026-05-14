/**
 * Browser-compatible Logger Utility Module
 * Provides log level filtering for console output in browser context.
 * Note: File logging is not available in browser, only console output.
 */

// Log levels in order of severity
export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Default log level (can be overridden via localStorage or URL parameter)
const DEFAULT_LOG_LEVEL: LogLevel = "warn";

// Check if we're in a browser environment
const isBrowser = typeof window !== "undefined" && typeof localStorage !== "undefined";

// Get console log level from localStorage or environment (defaults to DEFAULT_LOG_LEVEL)
function getConsoleLogLevel(): LogLevel {
  // Only check browser APIs if we're in a browser
  if (isBrowser) {
    // Check localStorage first (for runtime changes)
    const stored = localStorage.getItem("LOG_LEVEL");
    if (stored && stored in LOG_LEVELS) {
      return stored as LogLevel;
    }

    // Check URL parameter (for easy testing)
    const urlParams = new URLSearchParams(window.location.search);
    const urlLevel = urlParams.get("logLevel");
    if (urlLevel && urlLevel in LOG_LEVELS) {
      return urlLevel as LogLevel;
    }
  }

  // In Node/Bun, check environment variable
  if (typeof process !== "undefined" && process.env?.LOG_LEVEL) {
    const envLevel = process.env.LOG_LEVEL;
    if (envLevel in LOG_LEVELS) {
      return envLevel as LogLevel;
    }
  }

  // Default to DEFAULT_LOG_LEVEL
  return DEFAULT_LOG_LEVEL;
}

// Store original console methods before overriding
const originalConsoleLog = console.log;
const originalConsoleInfo = console.info;
const originalConsoleDebug = console.debug;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

// Check if message should be logged to console
function shouldLogToConsole(level: LogLevel): boolean {
  const consoleLevel = getConsoleLogLevel();
  return LOG_LEVELS[level] >= LOG_LEVELS[consoleLevel];
}

// Core logging function (uses original console methods to avoid recursion)
function log(level: LogLevel, ...args: unknown[]): void {
  // Only write to console if level meets threshold
  if (shouldLogToConsole(level)) {
    switch (level) {
      case "debug":
        originalConsoleDebug(...args);
        break;
      case "info":
        originalConsoleInfo(...args);
        break;
      case "warn":
        originalConsoleWarn(...args);
        break;
      case "error":
        originalConsoleError(...args);
        break;
    }
  }
}

// Public API
export function logDebug(message: string, ...args: unknown[]): void {
  log("debug", message, ...args);
}

export function logInfo(message: string, ...args: unknown[]): void {
  log("info", message, ...args);
}

export function logWarn(message: string, ...args: unknown[]): void {
  log("warn", message, ...args);
}

export function logError(message: string, ...args: unknown[]): void {
  log("error", message, ...args);
}

// Utility to get current console log level
export function getLogLevel(): LogLevel {
  return getConsoleLogLevel();
}

// Helper to stringify objects in console arguments to prevent [object Object] output
function stringifyArgs(args: unknown[]): unknown[] {
  return args.map(arg => {
    if (arg === null || arg === undefined) {
      return arg;
    }
    if (typeof arg === "object") {
      try {
        // Try JSON.stringify first for better formatting
        return JSON.stringify(arg, null, 2);
      } catch {
        // Fallback to String() if circular reference or other issue
        return String(arg);
      }
    }
    return arg;
  });
}

// Override console methods to route through our logger
// This catches third-party library logs (like Parakeet.js)
// We route console.log/info/debug to debug level (most verbose)
// and console.warn/error to their respective levels
// Objects are stringified to prevent [object Object] output in Chromium
console.log = (...args: unknown[]) => {
  log("debug", ...stringifyArgs(args));
};

console.info = (...args: unknown[]) => {
  log("debug", ...stringifyArgs(args));
};

console.debug = (...args: unknown[]) => {
  log("debug", ...stringifyArgs(args));
};

// Route console.warn and console.error through our logger
console.warn = (...args: unknown[]) => {
  log("warn", ...stringifyArgs(args));
};

console.error = (...args: unknown[]) => {
  log("error", ...stringifyArgs(args));
};

