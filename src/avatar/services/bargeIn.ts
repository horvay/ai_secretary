import type { AvatarInstance } from "../components/avatar/types";

export interface BargeInDeps {
  avatar: AvatarInstance;
  interruptAndResetUI: (reason: string) => Promise<void>;
  logDebug: (message: string, ...args: unknown[]) => void;
  logInfo: (message: string, ...args: unknown[]) => void;
}

export function createBargeInController({ avatar, interruptAndResetUI, logDebug, logInfo }: BargeInDeps) {
  let bargeInSpeechStartTime: number | null = null;
  let bargeInCheckInterval: ReturnType<typeof setInterval> | null = null;
  let bargeInEnabled: boolean = true; // Can be toggled via settings
  let bargeInThresholdMs: number = 200; // 0.2 seconds default

  /**
   * Start tracking barge-in speech duration
   */
  function startBargeInTracking(): void {
    if (!bargeInEnabled) return;
    if (bargeInSpeechStartTime !== null) return; // Already tracking

    const avatarState = avatar.getState();
    if (avatarState !== "talking" && avatarState !== "processing") return;

    bargeInSpeechStartTime = Date.now();
    logDebug(`🎤 Barge-in: Started tracking speech at ${new Date(bargeInSpeechStartTime).toISOString()}`);

    // Start checking if we've reached the threshold
    if (bargeInCheckInterval === null) {
      bargeInCheckInterval = setInterval(() => {
        void checkBargeInThreshold();
      }, 50); // Check frequently for snappy barge-in
    }
  }

  /**
   * Stop tracking barge-in speech duration
   */
  function stopBargeInTracking(): void {
    if (bargeInSpeechStartTime !== null) {
      const duration = Date.now() - bargeInSpeechStartTime;
      logDebug(`🎤 Barge-in: Stopped tracking after ${duration}ms`);
    }
    bargeInSpeechStartTime = null;

    if (bargeInCheckInterval !== null) {
      clearInterval(bargeInCheckInterval);
      bargeInCheckInterval = null;
    }
  }

  /**
   * Check if barge-in threshold has been reached
   */
  async function checkBargeInThreshold(): Promise<void> {
    if (!bargeInEnabled || bargeInSpeechStartTime === null) {
      stopBargeInTracking();
      return;
    }

    const avatarState = avatar.getState();
    if (avatarState !== "talking" && avatarState !== "processing") {
      stopBargeInTracking();
      return;
    }

    const duration = Date.now() - bargeInSpeechStartTime;
    if (duration >= bargeInThresholdMs) {
      logInfo(`🛑 Barge-in triggered: User spoke for ${duration}ms during response`);
      await interruptAndResetUI(`barge-in (${duration}ms)`);
    }
  }

  /**
   * Set barge-in enabled state (from settings)
   */
  function setBargeInEnabled(enabled: boolean): void {
    bargeInEnabled = enabled;
    if (!enabled) {
      stopBargeInTracking();
    }
    logInfo(`🎤 Barge-in ${enabled ? "enabled" : "disabled"}`);
  }

  /**
   * Set barge-in threshold in seconds (from settings)
   */
  function setBargeInThreshold(seconds: number): void {
    bargeInThresholdMs = seconds * 1000;
    logInfo(`🎤 Barge-in threshold set to ${seconds}s`);
  }

  return {
    startBargeInTracking,
    stopBargeInTracking,
    checkBargeInThreshold,
    setBargeInEnabled,
    setBargeInThreshold,
    getBargeInEnabled: () => bargeInEnabled,
    getBargeInThresholdMs: () => bargeInThresholdMs,
  };
}
