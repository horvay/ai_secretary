/**
 * Temporary File Management
 * Provides a shared temp file system for binary data (screenshots, audio)
 * Files are automatically cleaned up after a TTL
 */

import { join } from "path";
import { tmpdir } from "os";
import { mkdir, writeFile, unlink, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { randomBytes } from "crypto";
import { pathToFileURL } from "url";
import { logDebug, logWarn } from "./logger";

// Configuration
const TEMP_DIR = join(tmpdir(), "ai-secretary-temp");
const FILE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // Run cleanup every minute

interface TempFile {
  id: string;
  path: string;
  url: string; // file:// URL for local access
  createdAt: number;
}

// Track active files for cleanup
const activeFiles = new Map<string, TempFile>();
let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Ensure the temp directory exists
 */
export async function initTempDir(): Promise<void> {
  if (!existsSync(TEMP_DIR)) {
    await mkdir(TEMP_DIR, { recursive: true });
    logDebug(`📁 Created temp directory: ${TEMP_DIR}`);
  }

  // Start cleanup interval
  if (!cleanupIntervalId) {
    cleanupIntervalId = setInterval(() => {
      cleanupExpiredFiles().catch((err) => {
        logWarn("Temp file cleanup error:", err);
      });
    }, CLEANUP_INTERVAL_MS);
  }
}

/**
 * Create a temporary file with the given data
 * @param data - Buffer data to write
 * @param extension - File extension (e.g., 'png', 'wav')
 * @returns TempFile object with path and URL
 */
export async function createTempFile(data: Buffer, extension: string): Promise<TempFile> {
  await initTempDir();

  const id = randomBytes(8).toString("hex");
  const filename = `${id}.${extension}`;
  const filePath = join(TEMP_DIR, filename);

  await writeFile(filePath, data);

  const tempFile: TempFile = {
    id,
    path: filePath,
    url: pathToFileURL(filePath).href,
    createdAt: Date.now(),
  };

  activeFiles.set(id, tempFile);
  logDebug(`📁 Temp file created: ${filename} (${(data.length / 1024).toFixed(1)}KB)`);

  // Schedule individual file cleanup
  setTimeout(() => cleanupFile(id), FILE_TTL_MS);

  return tempFile;
}

/**
 * Read a temp file by its ID
 * @param id - The file ID
 * @returns Buffer or null if file doesn't exist
 */
export async function readTempFile(id: string): Promise<Buffer | null> {
  const file = activeFiles.get(id);
  if (!file) {
    return null;
  }

  try {
    const { readFile } = await import("fs/promises");
    return await readFile(file.path);
  } catch {
    return null;
  }
}

/**
 * Get a temp file by its ID
 * @param id - The file ID
 * @returns TempFile or null if not found
 */
export function getTempFile(id: string): TempFile | null {
  return activeFiles.get(id) || null;
}

/**
 * Manually cleanup a specific file
 * @param id - The file ID to cleanup
 */
async function cleanupFile(id: string): Promise<void> {
  const file = activeFiles.get(id);
  if (!file) return;

  try {
    await unlink(file.path);
    logDebug(`📁 Temp file cleaned up: ${id}`);
  } catch {
    // File might already be deleted
  }

  activeFiles.delete(id);
}

/**
 * Cleanup all expired files
 */
async function cleanupExpiredFiles(): Promise<void> {
  const now = Date.now();
  const expired: string[] = [];

  for (const [id, file] of activeFiles) {
    if (now - file.createdAt >= FILE_TTL_MS) {
      expired.push(id);
    }
  }

  for (const id of expired) {
    await cleanupFile(id);
  }

  if (expired.length > 0) {
    logDebug(`📁 Cleaned up ${expired.length} expired temp files`);
  }
}

/**
 * Cleanup all temp files (call during shutdown)
 */
export async function cleanupAllTempFiles(): Promise<void> {
  // Stop cleanup interval
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }

  // Clean up all active files
  for (const id of activeFiles.keys()) {
    await cleanupFile(id);
  }

  // Also clean up any orphaned files in the temp directory
  try {
    if (existsSync(TEMP_DIR)) {
      const files = await readdir(TEMP_DIR);
      for (const file of files) {
        try {
          await unlink(join(TEMP_DIR, file));
        } catch {
          // Ignore
        }
      }
    }
  } catch (err) {
    logWarn("Failed to clean up temp directory:", err);
  }

  logDebug("📁 All temp files cleaned up");
}

/**
 * Get temp directory path
 */
export function getTempDir(): string {
  return TEMP_DIR;
}

/**
 * Get stats about temp file usage
 */
export function getTempFileStats(): {
  activeCount: number;
  totalSize: number;
  oldestAgeMs: number;
} {
  let totalSize = 0;
  let oldestCreatedAt = Date.now();

  for (const file of activeFiles.values()) {
    // We don't have size tracked, but we could add it
    if (file.createdAt < oldestCreatedAt) {
      oldestCreatedAt = file.createdAt;
    }
  }

  return {
    activeCount: activeFiles.size,
    totalSize,
    oldestAgeMs: activeFiles.size > 0 ? Date.now() - oldestCreatedAt : 0,
  };
}
