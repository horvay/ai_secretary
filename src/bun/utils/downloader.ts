/**
 * Downloader Utility
 * Pure functions for downloading Piper binary and models on first run
 */

import { spawn } from "bun";
import { mkdir, writeFile, access, readdir, stat } from "fs/promises";
import { join } from "path";
import { getAiSecretaryDataDir } from "./paths";

// Constants
const DATA_DIR = getAiSecretaryDataDir();
const PIPER_DIR = join(DATA_DIR, "piper");

// Piper release URLs by platform
// Using latest release: 2023.11.14-2
const PIPER_RELEASES: Record<string, Record<string, string>> = {
  linux: {
    x64: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz",
    arm64: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_aarch64.tar.gz",
  },
  darwin: {
    x64: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_darwin_x86_64.tar.gz",
    arm64: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_darwin_arm64.tar.gz",
  },
  win32: {
    x64: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_x86_64.zip",
  },
};

// Default voice model (en_GB-cori-high) - High quality British English female voice
const DEFAULT_VOICE_MODEL = {
  url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/cori/high/en_GB-cori-high.onnx",
  config: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/cori/high/en_GB-cori-high.onnx.json",
};

/**
 * Ensure data directory exists
 */
async function ensureDirectory(): Promise<void> {
  try {
    await mkdir(PIPER_DIR, { recursive: true });
  } catch (error) {
    if (error instanceof Error && !error.message.includes("EEXIST")) {
      throw new Error(`Failed to create data directory: ${error.message}`);
    }
  }
}

/**
 * Check if file exists
 */
async function fileExists(filepath: string): Promise<boolean> {
  try {
    await access(filepath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Download file using fetch
 */
async function downloadFile(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  await writeFile(outputPath, Buffer.from(buffer));
}

/**
 * Get platform-specific Piper binary URL
 */
function getPiperUrl(): string | null {
  const platform = process.platform;
  const arch = process.arch;

  const platformReleases = PIPER_RELEASES[platform];
  if (!platformReleases) {
    return null;
  }

  return platformReleases[arch] || null;
}

/**
 * Check if Piper is already downloaded
 */
export async function isPiperInstalled(): Promise<boolean> {
  const binaryName = process.platform === "win32" ? "piper.exe" : "piper";

  // Check common locations where piper might be extracted
  const possiblePaths = [
    join(PIPER_DIR, "piper", binaryName), // Extracted to piper/ subdirectory
    join(PIPER_DIR, binaryName), // Direct extraction
  ];

  for (const path of possiblePaths) {
    if (await fileExists(path)) {
      return true;
    }
  }

  // Also check recursively
  try {
    const files = await readdir(PIPER_DIR, { recursive: true });
    const found = files.find((f) => {
      const name = String(f).split("/").pop() || String(f).split("\\").pop() || String(f);
      return name === "piper" || name === "piper.exe";
    });
    return found !== undefined;
  } catch {
    return false;
  }
}

/**
 * Check if voice model is downloaded
 */
export async function isVoiceModelInstalled(): Promise<boolean> {
  const modelPath = join(PIPER_DIR, "en_GB-cori-high.onnx");
  const configPath = join(PIPER_DIR, "en_GB-cori-high.onnx.json");
  return (await fileExists(modelPath)) && (await fileExists(configPath));
}

/**
 * Download Piper binary
 */
export async function downloadPiper(onProgress?: (progress: string) => void): Promise<string> {
  await ensureDirectory();

  const url = getPiperUrl();
  if (!url) {
    throw new Error(`Piper is not available for platform ${process.platform} ${process.arch}`);
  }

  onProgress?.(`Downloading Piper binary from ${url}...`);

  const archivePath = join(PIPER_DIR, url.split("/").pop() || "piper.tar.gz");
  await downloadFile(url, archivePath);

  onProgress?.("Extracting Piper binary...");

  const isZip = archivePath.endsWith(".zip");
  const isWindows = process.platform === "win32";

  function quotePowerShellSingle(value: string): string {
    // Escape single quotes in PowerShell single-quoted string literals.
    return `'${value.replace(/'/g, "''")}'`;
  }

  try {
    const proc = isZip && isWindows
      ? spawn(
          [
            "powershell",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Expand-Archive -Force -Path ${quotePowerShellSingle(archivePath)} -DestinationPath ${quotePowerShellSingle(PIPER_DIR)}`,
          ],
          {
            stdout: "pipe",
            stderr: "pipe",
            cwd: PIPER_DIR,
          }
        )
      : spawn([isZip ? "unzip" : "tar", ...(isZip ? ["-o", archivePath, "-d", PIPER_DIR] : ["-xzf", archivePath, "-C", PIPER_DIR])], {
          stdout: "pipe",
          stderr: "pipe",
          cwd: PIPER_DIR,
        });

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const error = await new Response(proc.stderr).text();
      const stdout = await new Response(proc.stdout).text();
      console.error("Extraction stderr:", error);
      console.error("Extraction stdout:", stdout);
      throw new Error(`Failed to extract Piper (exit code ${exitCode}): ${error || stdout}`);
    }
  } catch (error) {
    // If spawn fails, provide helpful error message
    if (error instanceof Error) {
      if (error.message.includes("ENOENT")) {
        const cmd = isZip ? (isWindows ? "powershell (Expand-Archive)" : "unzip") : "tar";
        throw new Error(`Extraction command (${cmd}) not found. Please install it or extract ${archivePath} manually to ${PIPER_DIR}`);
      }
      throw error;
    }
    throw error;
  }

  // Find the piper binary in extracted files
  const binaryName = process.platform === "win32" ? "piper.exe" : "piper";
  const possiblePaths = [
    join(PIPER_DIR, "piper", binaryName),
    join(PIPER_DIR, binaryName),
  ];

  // Try to find it in subdirectories
  let piperBinary: string | null = null;
  for (const path of possiblePaths) {
    if (await fileExists(path)) {
      piperBinary = path;
      break;
    }
  }

  if (!piperBinary) {
    // Search recursively
    try {
      const files = await readdir(PIPER_DIR, { recursive: true });
      const found = files.find((f) => {
        const name = String(f).split("/").pop() || String(f).split("\\").pop() || String(f);
        return (
          name === "piper" ||
          name === "piper.exe" ||
          (name.includes("piper") &&
            !name.includes(".so") &&
            !name.includes(".tar") &&
            (process.platform === "win32" ? name.endsWith(".exe") : !name.endsWith(".exe")))
        );
      });
      if (found) {
        piperBinary = join(PIPER_DIR, String(found));
      }
    } catch (error) {
      console.error("Error searching for piper binary:", error);
    }
  }

  if (!piperBinary || !(await fileExists(piperBinary))) {
    throw new Error(
      `Piper binary not found after extraction. Please check ${PIPER_DIR}. The binary should be in a 'piper' subdirectory.`
    );
  }

  onProgress?.(`Piper binary ready at ${piperBinary}`);
  return piperBinary;
}

/**
 * Download voice model
 */
export async function downloadVoiceModel(onProgress?: (progress: string) => void): Promise<void> {
  await ensureDirectory();

  onProgress?.("Downloading high-quality voice model from HuggingFace...");

  const modelPath = join(PIPER_DIR, "en_GB-cori-high.onnx");
  const configPath = join(PIPER_DIR, "en_GB-cori-high.onnx.json");

  await downloadFile(DEFAULT_VOICE_MODEL.url, modelPath);
  const fileStats = await stat(modelPath);
  const fileSize = fileStats.size / 1024 / 1024;
  onProgress?.(`Downloaded high-quality model (${fileSize.toFixed(1)}MB)`);

  await downloadFile(DEFAULT_VOICE_MODEL.config, configPath);
  onProgress?.("High-quality voice model ready");
}

/**
 * Get Piper binary path (searches for it)
 */
export async function getPiperPath(): Promise<string> {
  const binaryName = process.platform === "win32" ? "piper.exe" : "piper";

  // Check common locations
  const possiblePaths = [
    join(PIPER_DIR, "piper", binaryName),
    join(PIPER_DIR, binaryName),
  ];

  for (const path of possiblePaths) {
    if (await fileExists(path)) {
      return path;
    }
  }

  // Search recursively
  try {
    const files = await readdir(PIPER_DIR, { recursive: true });
    const found = files.find((f) => {
      const parts = String(f).split(/[/\\]/);
      const name = parts[parts.length - 1];
      return name === "piper" || name === "piper.exe";
    });
    if (found) {
      return join(PIPER_DIR, String(found));
    }
  } catch {
    // Ignore
  }

  // Fallback to expected location
  return possiblePaths[0];
}

/**
 * Get voice model path
 */
export function getVoiceModelPath(): string {
  return join(PIPER_DIR, "en_GB-cori-high.onnx");
}

// Legacy export for backwards compatibility
export const downloader = {
  isPiperInstalled,
  isVoiceModelInstalled,
  downloadPiper,
  downloadVoiceModel,
  getPiperPath,
  getVoiceModelPath,
};
