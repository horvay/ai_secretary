import { appendFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { getAiSecretaryLogsDir } from "./paths";

export interface VoiceTurnEvent {
  ts: string;
  turnId: string;
  event: string;
  source: "ai" | "audio" | "avatar";
  reason?: string;
  from?: string;
  to?: string;
  elapsedMs?: number;
  details?: Record<string, unknown>;
}

interface VoiceTurnBuffer {
  messages: string[];
  flushTimeout: ReturnType<typeof setTimeout> | null;
  isWriting: boolean;
  logDirEnsured: boolean;
}

const FLUSH_INTERVAL_MS = 100;
const MAX_BUFFER_SIZE = 50;

const buffer: VoiceTurnBuffer = {
  messages: [],
  flushTimeout: null,
  isWriting: false,
  logDirEnsured: false,
};

function getVoiceTurnLogFilePath(): string {
  const date = new Date().toISOString().split("T")[0];
  return path.join(getAiSecretaryLogsDir(), `voice-turns-${date}.log`);
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
    await appendFile(getVoiceTurnLogFilePath(), toWrite);
  } catch {
    // logging must never crash runtime
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
    void flushBuffer();
  }, FLUSH_INTERVAL_MS);
}

export function logVoiceTurnEvent(event: VoiceTurnEvent): void {
  try {
    buffer.messages.push(`${JSON.stringify(event)}\n`);
    if (buffer.messages.length >= MAX_BUFFER_SIZE) {
      if (buffer.flushTimeout) {
        clearTimeout(buffer.flushTimeout);
        buffer.flushTimeout = null;
      }
      void flushBuffer();
    } else {
      scheduleFlush();
    }
  } catch {
    // swallow log errors
  }
}

export async function flushVoiceTurnLogs(): Promise<void> {
  if (buffer.flushTimeout) {
    clearTimeout(buffer.flushTimeout);
    buffer.flushTimeout = null;
  }
  await flushBuffer();
}
