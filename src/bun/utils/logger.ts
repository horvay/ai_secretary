/**
 * Logger Utility Module
 * Provides log level filtering for console output while always writing
 * all logs (debug level) to a log file for debugging purposes.
 *
 * Uses async batched file writing to prevent blocking the main thread.
 */

import { mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { writeToFileAsync, flushLogs as flushAsyncLogs } from "./asyncLogger";

// Log levels in order of severity
export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Default log level (can be overridden via LOG_LEVEL environment variable)
const DEFAULT_LOG_LEVEL: LogLevel = "warn";

// Get console log level from environment (defaults to DEFAULT_LOG_LEVEL)
function getConsoleLogLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (envLevel && envLevel in LOG_LEVELS) {
    return envLevel as LogLevel;
  }
  return DEFAULT_LOG_LEVEL;
}

// Get log directory path
function getLogDir(): string {
  return join(homedir(), ".ai-secretary", "logs");
}

// Get current log file path (daily rotation)
function getLogFilePath(): string {
  const date = new Date();
  const dateStr = date.toISOString().split("T")[0]; // YYYY-MM-DD
  return join(getLogDir(), `ai-secretary-${dateStr}.log`);
}

// Ensure log directory exists
function ensureLogDir(): void {
  const logDir = getLogDir();
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
}

// Format timestamp for log entries
function formatTimestamp(): string {
  return new Date().toISOString();
}

// Format log message
function formatMessage(level: LogLevel, message: string, args: unknown[]): string {
  const timestamp = formatTimestamp();
  const levelStr = level.toUpperCase().padEnd(5);

  // Format additional arguments
  let formattedArgs = "";
  if (args.length > 0) {
    formattedArgs = " " + args.map(arg => {
      if (typeof arg === "object") {
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    }).join(" ");
  }

  return `[${timestamp}] [${levelStr}] ${message}${formattedArgs}`;
}

// Write to log file (always at debug level - all logs)
// Uses async batched writing to prevent blocking the main thread
function writeToFile(formattedMessage: string): void {
  writeToFileAsync(formattedMessage);
}

// Check if message should be logged to console
function shouldLogToConsole(level: LogLevel): boolean {
  const consoleLevel = getConsoleLogLevel();
  return LOG_LEVELS[level] >= LOG_LEVELS[consoleLevel];
}

// Core logging function
function log(level: LogLevel, message: string, ...args: unknown[]): void {
  const formattedMessage = formatMessage(level, message, args);

  // Always write to file (maximum verbosity)
  writeToFile(formattedMessage);

  // Only write to console if level meets threshold
  if (shouldLogToConsole(level)) {
    switch (level) {
      case "debug":
        console.debug(message, ...args);
        break;
      case "info":
        console.log(message, ...args);
        break;
      case "warn":
        console.warn(message, ...args);
        break;
      case "error":
        console.error(message, ...args);
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

// Utility to get current log file path (for debugging/reference)
export function getCurrentLogFile(): string {
  return getLogFilePath();
}

// Utility to get current console log level
export function getLogLevel(): LogLevel {
  return getConsoleLogLevel();
}

// Flush all pending log messages (call during shutdown)
export async function flushLogs(): Promise<void> {
  await flushAsyncLogs();
}