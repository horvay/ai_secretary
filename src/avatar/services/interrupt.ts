import type { AvatarInstance } from "../components/avatar/types";
import type { ChatBubbleInstance } from "../components/ChatBubble";

export interface InterruptDeps {
  avatar: AvatarInstance;
  chatBubble: ChatBubbleInstance;
  electronRpc: { rpc: { request: { interruptResponse: (payload: {}) => Promise<void> } } };
  stopAudio: () => void;
  suppressPlayback: () => void;
  stopBargeInTracking: () => void;
  activateFollowupMode: () => void;
  restartMicrophoneListening: () => void;
  responseHideTimeout: { current: number | null };
  errorHideTimeout: { current: number | null };
  isProcessingAI: { current: boolean };
  logInfo: (message: string, ...args: unknown[]) => void;
  logWarn: (message: string, ...args: unknown[]) => void;
}

export function createInterruptHandler(deps: InterruptDeps) {
  const {
    avatar,
    chatBubble,
    electronRpc,
    stopAudio,
    suppressPlayback,
    stopBargeInTracking,
    activateFollowupMode,
    restartMicrophoneListening,
    responseHideTimeout,
    errorHideTimeout,
    isProcessingAI,
    logInfo,
    logWarn,
  } = deps;

  let interruptInFlight: Promise<void> | null = null;
  let lastInterruptTime: number = 0;

  /**
   * Unified interrupt handler (used by Escape, Skip button, voice commands, and barge-in).
   * Stops local audio immediately, requests backend interrupt, then resets UI state consistently.
   */
  async function interruptAndResetUI(reason: string): Promise<void> {
    if (interruptInFlight) {
      return interruptInFlight;
    }

    interruptInFlight = (async () => {
      logInfo(`🛑 Interrupting response: ${reason}`);

      // Record interrupt time so we can avoid dropping the user's immediate next utterance due to debounce
      lastInterruptTime = Date.now();

      // Stop local audio immediately (frontend)
      suppressPlayback();

      // Prevent repeated barge-in firing while we're interrupting
      stopBargeInTracking();

      // Clear any pending auto-hide timers so UI doesn't "re-hide" later
      if (responseHideTimeout.current) {
        clearTimeout(responseHideTimeout.current);
        responseHideTimeout.current = null;
      }
      if (errorHideTimeout.current) {
        clearTimeout(errorHideTimeout.current);
        errorHideTimeout.current = null;
      }

      // Ask backend to interrupt. If the RPC fails transiently, retry once.
      try {
        await electronRpc.rpc.request.interruptResponse({});
      } catch (err) {
        logWarn("Failed to interrupt response (attempt 1):", err);
        try {
          await new Promise((r) => setTimeout(r, 150));
          await electronRpc.rpc.request.interruptResponse({});
        } catch (err2) {
          logWarn("Failed to interrupt response (attempt 2):", err2);
        }
      }

      // Reset processing + UI (make behavior consistent across all interrupt sources)
      isProcessingAI.current = false;
      avatar.setState("idle");
      chatBubble.hide();
      chatBubble.hideUserQuestion();

      // Stop audio again to catch any chunk that started between our first stop and the backend interrupt.
      stopAudio();

      // After interrupting, treat the user's next speech as a follow-up by default.
      // This ensures speech without explicitly saying "Ari" is routed to AI instead of background context.
      activateFollowupMode();

      // Always restart mic listening so user can speak immediately after interrupt.
      // restartMicrophoneListening() already checks if mic is enabled and not already running.
      restartMicrophoneListening();
    })()
      .finally(() => {
        interruptInFlight = null;
      });

    return interruptInFlight;
  }

  return {
    interruptAndResetUI,
    getLastInterruptTime: () => lastInterruptTime,
  };
}
