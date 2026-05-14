/**
 * Process Utilities
 * Cross-platform process management functions
 */

// Platform detection
const isWindows = process.platform === "win32";

function quotePowerShellSingle(s: string): string {
  // In PowerShell single-quoted strings, escape ' as ''.
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Cross-platform process killing utility (async)
 * Uses taskkill on Windows, pkill on Linux/macOS
 */
export async function killProcessByPattern(pattern: string): Promise<void> {
  const { spawn: nodeSpawn } = await import("child_process");

  return new Promise<void>((resolve) => {
    if (isWindows) {
      // On Windows:
      // - Prefer taskkill when pattern obviously references an executable
      // - Also support command-line substring matching via PowerShell for specific command patterns
      const maybeExe =
        pattern.toLowerCase().endsWith(".exe") || /^[a-z0-9._-]+$/i.test(pattern)
          ? (pattern.toLowerCase().endsWith(".exe") ? pattern : `${pattern}.exe`)
          : null;

      const procs: Array<ReturnType<typeof nodeSpawn>> = [];

      if (maybeExe) {
        procs.push(
          nodeSpawn("taskkill", ["/F", "/IM", maybeExe, "/T"], {
            stdio: "ignore",
          })
        );
      }

      // PowerShell fallback: match by Name or CommandLine substring (best-effort).
      const ps = `
$p = ${quotePowerShellSingle(pattern)};
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -like ("*" + $p + "*") -or ($_.CommandLine -and $_.CommandLine -like ("*" + $p + "*")) } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }
`;
      procs.push(
        nodeSpawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
          stdio: "ignore",
        })
      );

      let remaining = procs.length;
      const done = () => {
        remaining -= 1;
        if (remaining <= 0) resolve();
      };

      for (const p of procs) {
        p.on("exit", done);
        p.on("error", done);
      }

      setTimeout(resolve, 800);
    } else {
      // On Linux/macOS, use pkill
      const proc = nodeSpawn("pkill", ["-9", "-f", pattern], {
        stdio: "ignore",
      });
      proc.on("exit", () => resolve());
      proc.on("error", () => resolve());
      setTimeout(resolve, 500);
    }
  });
}

/**
 * Synchronous cross-platform process killing
 * Used in exit handlers where async doesn't work
 */
export function killProcessByPatternSync(pattern: string): void {
  try {
    const { spawnSync } = require("child_process");

    if (isWindows) {
      const maybeExe =
        pattern.toLowerCase().endsWith(".exe") || /^[a-z0-9._-]+$/i.test(pattern)
          ? (pattern.toLowerCase().endsWith(".exe") ? pattern : `${pattern}.exe`)
          : null;

      if (maybeExe) {
        spawnSync("taskkill", ["/F", "/IM", maybeExe, "/T"], { timeout: 500 });
      }

      const ps = `
$p = ${quotePowerShellSingle(pattern)};
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -like ("*" + $p + "*") -or ($_.CommandLine -and $_.CommandLine -like ("*" + $p + "*")) } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }
`;
      spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 800 });
    } else {
      spawnSync("pkill", ["-9", "-f", pattern], { timeout: 500 });
    }
  } catch {
    // Ignore errors - process may not exist
  }
}

/**
 * Check if running on Windows
 */
export function isWindowsPlatform(): boolean {
  return isWindows;
}

