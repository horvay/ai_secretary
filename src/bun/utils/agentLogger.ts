/**
 * Agent Logger Utility
 * Writes detailed agent events to agent.log for debugging/auditing.
 *
 * Design goals:
 * - Never crash the app if logging fails
 * - Buffered async writes to avoid blocking
 * - Stable location under AI Secretary logs dir
 */

import { appendFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { getAiSecretaryLogsDir } from "./paths";

interface AgentLogBuffer {
  messages: string[];
  flushTimeout: ReturnType<typeof setTimeout> | null;
  isWriting: boolean;
  logDirEnsured: boolean;
}

const FLUSH_INTERVAL_MS = 100;
const MAX_BUFFER_SIZE = 50;

const buffer: AgentLogBuffer = {
  messages: [],
  flushTimeout: null,
  isWriting: false,
  logDirEnsured: false,
};

function getAgentLogFilePath(): string {
  return path.join(getAiSecretaryLogsDir(), "agent.log");
}

async function ensureLogDirAsync(): Promise<void> {
  if (buffer.logDirEnsured) return;
  const dir = getAiSecretaryLogsDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  buffer.logDirEnsured = true;
}

async function flushBuffer(): Promise<void> {
  if (buffer.messages.length === 0 || buffer.isWriting) return;

  buffer.isWriting = true;
  const toWrite = buffer.messages.join("");
  buffer.messages = [];

  try {
    await ensureLogDirAsync();
    await appendFile(getAgentLogFilePath(), toWrite);
  } catch {
    // Swallow errors; logging must never crash the app.
  } finally {
    buffer.isWriting = false;
    if (buffer.messages.length > 0) {
      scheduleFlush();
    }
  }
}

function scheduleFlush(): void {
  if (buffer.flushTimeout) return;
  buffer.flushTimeout = setTimeout(() => {
    buffer.flushTimeout = null;
    flushBuffer();
  }, FLUSH_INTERVAL_MS);
}

export function writeAgentLogLine(line: string): void {
  buffer.messages.push(line.endsWith("\n") ? line : line + "\n");

  if (buffer.messages.length >= MAX_BUFFER_SIZE) {
    if (buffer.flushTimeout) {
      clearTimeout(buffer.flushTimeout);
      buffer.flushTimeout = null;
    }
    void flushBuffer();
  } else {
    scheduleFlush();
  }
}

export function logAgentEvent(event: unknown): void {
  const entry = {
    timestamp: new Date().toISOString(),
    event,
  };
  try {
    writeAgentLogLine(JSON.stringify(entry));
  } catch {
    // ignore
  }
}

export async function flushAgentLogs(): Promise<void> {
  if (buffer.flushTimeout) {
    clearTimeout(buffer.flushTimeout);
    buffer.flushTimeout = null;
  }
  await flushBuffer();
}

