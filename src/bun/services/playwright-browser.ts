import { existsSync } from "fs";
import { mkdir, readdir } from "fs/promises";
import path from "path";
import { getAiSecretaryDataDir, getProjectRootDir } from "../utils/paths";
import { logInfo } from "../utils/logger";

export type PlaywrightBrowserStatus = {
  enabled: boolean;
  installed: boolean;
  browsersDir: string;
  executablePath: string | null;
};

function getManagedBrowsersDir() {
  return path.join(getAiSecretaryDataDir(), "browsers", "playwright");
}

function getPlaywrightCliPath() {
  const projectPath = path.join(getProjectRootDir(), "node_modules", "playwright", "cli.js");
  if (existsSync(projectPath)) return projectPath;

  const mcpNestedPath = path.join(getProjectRootDir(), "node_modules", "@playwright", "mcp", "node_modules", "playwright", "cli.js");
  if (existsSync(mcpNestedPath)) return mcpNestedPath;

  throw new Error("Bundled Playwright CLI not found. The app package is missing playwright.");
}

export function getPlaywrightMcpCliPath() {
  const projectPath = path.join(getProjectRootDir(), "node_modules", "@playwright", "mcp", "cli.js");
  if (existsSync(projectPath)) return projectPath;
  throw new Error("Bundled Playwright MCP CLI not found. The app package is missing @playwright/mcp.");
}

function executableTailCandidates() {
  if (process.platform === "win32") return [path.join("chrome-win64", "chrome.exe"), path.join("chrome-win", "chrome.exe")];
  if (process.platform === "darwin") {
    return process.arch === "arm64"
      ? [path.join("chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing")]
      : [path.join("chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing")];
  }
  return [path.join("chrome-linux64", "chrome"), path.join("chrome-linux", "chrome")];
}

async function findManagedChromiumExecutable() {
  const browsersDir = getManagedBrowsersDir();
  if (!existsSync(browsersDir)) return null;

  const entries = await readdir(browsersDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("chromium")) continue;
    const root = path.join(browsersDir, entry.name);
    for (const tail of executableTailCandidates()) {
      const candidate = path.join(root, tail);
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

export async function getManagedPlaywrightBrowserStatus(enabled: boolean): Promise<PlaywrightBrowserStatus> {
  const executablePath = await findManagedChromiumExecutable();
  return {
    enabled,
    installed: executablePath !== null,
    browsersDir: getManagedBrowsersDir(),
    executablePath,
  };
}

export async function ensureManagedChromiumDownloaded(onProgress?: (message: string) => void) {
  const existing = await findManagedChromiumExecutable();
  if (existing) return existing;

  const browsersDir = getManagedBrowsersDir();
  await mkdir(browsersDir, { recursive: true });

  const cliPath = getPlaywrightCliPath();
  const env = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: browsersDir,
    PLAYWRIGHT_SKIP_BROWSER_GC: "1",
  };

  const command = [process.execPath, cliPath, "install", "chromium"];
  const startMessage = `Downloading Playwright Chromium for ${process.platform}/${process.arch} into ${browsersDir}`;
  logInfo(`[playwright-browser] ${startMessage}`);
  onProgress?.(startMessage);

  const proc = Bun.spawn(command, {
    cwd: getProjectRootDir(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const forward = async (stream: ReadableStream<Uint8Array>, prefix: string) => {
    for await (const chunk of stream) {
      const text = new TextDecoder().decode(chunk).trimEnd();
      if (!text) continue;
      const message = `${prefix}: ${text}`;
      logInfo(`[playwright-browser] ${message}`);
      onProgress?.(message);
    }
  };

  await Promise.all([forward(proc.stdout, "stdout"), forward(proc.stderr, "stderr"), proc.exited]);

  if (proc.exitCode !== 0) {
    throw new Error(`Playwright Chromium download failed with exit code ${proc.exitCode}`);
  }

  const installed = await findManagedChromiumExecutable();
  if (!installed) throw new Error(`Playwright Chromium download completed but no executable was found in ${browsersDir}`);
  return installed;
}
