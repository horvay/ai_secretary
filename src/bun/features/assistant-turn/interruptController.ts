import { logInfo } from "../../utils/logger";
import { logVoiceTurnEvent } from "../../utils/voiceTurnLogger";
import { stopCurrentAudio, type AudioQueue } from "../../services/audio";
import { finalizeActiveTurn, getActiveTurnId, setActiveTurnId } from "./turnLifecycle";

let currentAudioQueue: AudioQueue | null = null;
let currentAbortController: AbortController | null = null;
let wasInterrupted = false;

export function setCurrentAudioQueue(queue: AudioQueue | null): void {
  currentAudioQueue = queue;
}

export function clearCurrentAudioQueue(): void {
  currentAudioQueue = null;
}

export function setCurrentAbortController(controller: AbortController | null): void {
  currentAbortController = controller;
}

export function getCurrentAbortController(): AbortController | null {
  return currentAbortController;
}

export function clearCurrentAbortController(): void {
  currentAbortController = null;
}

export function markInterrupted(value: boolean): void {
  wasInterrupted = value;
}

export function getWasInterrupted(): boolean {
  return wasInterrupted;
}

export function interruptCurrentResponse(reason: string = "interrupt_request"): boolean {
  const hadActiveQueue = currentAudioQueue !== null;
  const hadActiveRequest = currentAbortController !== null;
  const interruptedTurnId = getActiveTurnId();

  currentAudioQueue?.cancel();
  currentAudioQueue = null;

  currentAbortController?.abort();
  currentAbortController = null;

  stopCurrentAudio();
  wasInterrupted = true;

  finalizeActiveTurn(reason);

  logInfo("🛑 Response interrupted");
  if (interruptedTurnId) {
    logVoiceTurnEvent({
      ts: new Date().toISOString(),
      turnId: interruptedTurnId,
      event: "turn_interrupted",
      source: "ai",
      reason,
    });
  }
  setActiveTurnId(null);

  return hadActiveQueue || hadActiveRequest;
}
