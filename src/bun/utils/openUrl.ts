import { spawn } from "child_process";

/**
 * Best-effort open a URL in the system browser (non-blocking).
 * This is used for OAuth flows.
 */
export function openUrl(url: string): void {
  try {
    if (process.platform === "win32") {
      // `start` is a built-in of cmd.exe. Empty title argument is required to avoid treating URL as title.
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
      return;
    }

    if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
      return;
    }

    // Linux and other unix-y platforms
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // ignore - caller surfaces follow-up auth errors if needed
  }
}

