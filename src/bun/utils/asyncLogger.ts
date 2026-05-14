/**
 * Async Logger Utility
 * Batched async file logging to prevent blocking the main thread
 */

import { mkdir, appendFile } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

interface LogBuffer {
  messages: string[];
  flushTimeout: ReturnType<typeof setTimeout> | null;
  isWriting: boolean;
  logDirEnsured: boolean;
}

// Configuration
const FLUSH_INTERVAL_MS = 100; // Flush every 100ms
const MAX_BUFFER_SIZE = 50; // Or when buffer has 50 messages

// Buffer state
const buffer: LogBuffer = {
  messages: [],
  flushTimeout: null,
  isWriting: false,
  logDirEnsured: false,
};

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

// Ensure log directory exists (async)
async function ensureLogDirAsync(): Promise<void> {
  if (buffer.logDirEnsured) return;

  const logDir = getLogDir();
  if (!existsSync(logDir)) {
    await mkdir(logDir, { recursive: true });
  }
  buffer.logDirEnsured = true;
}

/**
 * Flush the buffer to disk
 */
async function flushBuffer(): Promise<void> {
  if (buffer.messages.length === 0 || buffer.isWriting) return;

  buffer.isWriting = true;
  const toWrite = buffer.messages.join("");
  buffer.messages = [];

  try {
    await ensureLogDirAsync();
    await appendFile(getLogFilePath(), toWrite);
  } catch (error) {
    // Silently fail - don't let logging crash the app
    // If we really need to debug this, we could console.error here
  } finally {
    buffer.isWriting = false;

    // Check if more messages accumulated while writing
    if (buffer.messages.length > 0) {
      scheduleFlush();
    }
  }
}

/**
 * Schedule a flush if not already scheduled
 */
function scheduleFlush(): void {
  if (buffer.flushTimeout) return;

  buffer.flushTimeout = setTimeout(() => {
    buffer.flushTimeout = null;
    flushBuffer();
  }, FLUSH_INTERVAL_MS);
}

/**
 * Write a message to the log file asynchronously
 * Messages are buffered and written in batches
 */
export function writeToFileAsync(message: string): void {
  buffer.messages.push(message + "\n");

  // Immediate flush if buffer is large
  if (buffer.messages.length >= MAX_BUFFER_SIZE) {
    if (buffer.flushTimeout) {
      clearTimeout(buffer.flushTimeout);
      buffer.flushTimeout = null;
    }
    flushBuffer();
  } else {
    scheduleFlush();
  }
}

/**
 * Force flush all pending log messages
 * Should be called during shutdown to ensure all logs are written
 */
export async function flushLogs(): Promise<void> {
  if (buffer.flushTimeout) {
    clearTimeout(buffer.flushTimeout);
    buffer.flushTimeout = null;
  }
  await flushBuffer();
}

/**
 * Get the number of pending log messages
 */
export function getPendingCount(): number {
  return buffer.messages.length;
}

/**
 * Check if there are pending logs
 */
export function hasPendingLogs(): boolean {
  return buffer.messages.length > 0 || buffer.isWriting;
}
