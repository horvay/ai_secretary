/**
 * Audio Player Service
 * Handles audio playback via WebAudio with HTML <audio> element fallback.
 *
 * Chromium enforces browser autoplay policy, which
 * blocks AudioContext from starting without a user gesture. Since Electron
 * doesn't expose Chromium command-line switches, we can't set
 * --autoplay-policy=no-user-gesture-required. Instead, we:
 *
 *   1. Try AudioContext first (best quality, gain node support)
 *   2. Fall back to HTML <audio> element when AudioContext is suspended
 *   3. Keep trying to resume AudioContext on user gestures so it eventually works
 */

import { logDebug, logWarn, logError } from "../utils/logger";

// ============================================================================
// Module state
// ============================================================================
let currentSource: AudioBufferSourceNode | null = null;
let currentAudioElement: HTMLAudioElement | null = null; // Fallback element
let audioContext: AudioContext | null = null;
let masterGainNode: GainNode | null = null;
let isMuted: boolean = false;
let currentVolume: number = 1.0; // 0..1, preserved across mute/unmute
let currentChunkVolume: number = 1.0; // 0..1, per-play multiplier
let playbackResolve: ((value: void | PromiseLike<void>) => void) | null = null;
let playbackToken: number = 0; // increments to invalidate in-flight decode/play
let usingFallback: boolean = false; // true if AudioContext is broken and we're using <audio>
let playbackSuppressed: boolean = false; // suppress any new chunks after interrupt
let blockedPlayback:
  | {
      audioData: string;
      localResolve: () => void;
      localToken: number;
      timeoutId: number | null;
      requestedAt: number;
    }
  | null = null;

const BLOCKED_PLAYBACK_TIMEOUT_MS = 12000;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 1.0;
  return Math.max(0.0, Math.min(1.0, v));
}

function getAudioContextClass(): typeof AudioContext | null {
  const AudioContextClass =
    AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return AudioContextClass ?? null;
}

async function ensureAudioContext(): Promise<AudioContext> {
  if (!audioContext) {
    const AudioContextClass = getAudioContextClass();
    if (!AudioContextClass) {
      throw new Error("WebAudio not supported: AudioContext unavailable");
    }
    audioContext = new AudioContextClass();
  }

  if (!masterGainNode) {
    masterGainNode = audioContext.createGain();
    masterGainNode.gain.value = isMuted ? 0 : currentVolume * currentChunkVolume;
    masterGainNode.connect(audioContext.destination);
    logDebug("🔊 Created master gain node");
  }

  // Ensure the context is running (best-effort; callers may still handle failures)
  try {
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
  } catch (e) {
    logWarn("AudioContext resume failed:", e);
  }

  return audioContext;
}

/**
 * Check whether AudioContext is usable (running state).
 * If the context doesn't exist yet or is suspended, returns false.
 */
function isAudioContextRunning(): boolean {
  return audioContext !== null && audioContext.state === "running";
}

async function recreateAudioContextForRetry(): Promise<void> {
  if (currentSource) {
    try {
      currentSource.onended = null;
      currentSource.stop(0);
    } catch {
      // ignore
    }
    try {
      currentSource.disconnect();
    } catch {
      // ignore
    }
    currentSource = null;
  }

  if (masterGainNode) {
    try {
      masterGainNode.disconnect();
    } catch {
      // ignore
    }
    masterGainNode = null;
  }

  if (audioContext) {
    try {
      if (audioContext.state !== "closed") {
        await audioContext.close();
      }
    } catch {
      // ignore
    }
    audioContext = null;
  }
}

function applyEffectiveGain(): void {
  const ctx = audioContext;
  const gain = masterGainNode;
  if (!ctx || !gain) return;
  const effective = isMuted ? 0 : currentVolume * currentChunkVolume;
  try {
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(effective, ctx.currentTime);
  } catch (e) {
    try {
      gain.gain.value = effective;
    } catch {
      // ignore
    }
  }
}

/**
 * Apply volume to the fallback <audio> element (if active).
 */
function applyFallbackVolume(): void {
  if (currentAudioElement) {
    currentAudioElement.volume = isMuted ? 0 : clamp01(currentVolume * currentChunkVolume);
  }
}

function isAutoplayBlockedError(err: unknown): boolean {
  if (!err) return false;
  const maybeDom = err as { name?: string; message?: string };
  const name = (maybeDom.name ?? "").toString();
  const message = (maybeDom.message ?? "").toLowerCase();
  if (name === "NotAllowedError") return true;
  if (message.includes("not allowed")) return true;
  if (message.includes("user gesture")) return true;
  if (message.includes("play() failed")) return true;
  return false;
}

function clearBlockedPlayback(reason: string, resolve: boolean = true): void {
  if (!blockedPlayback) return;
  const { localResolve, timeoutId } = blockedPlayback;
  blockedPlayback = null;
  if (timeoutId !== null) {
    clearTimeout(timeoutId);
  }
  if (resolve) {
    try {
      if (playbackResolve === localResolve) {
        playbackResolve = null;
      }
      localResolve();
    } catch {
      // ignore
    }
  }
  logDebug(`🔊 Cleared blocked playback (${reason})`);
}

function registerBlockedPlayback(
  audioData: string,
  localResolve: () => void,
  localToken: number
): void {
  if (blockedPlayback) {
    clearBlockedPlayback("replaced");
  }

  const timeoutId = window.setTimeout(() => {
    clearBlockedPlayback("timeout");
  }, BLOCKED_PLAYBACK_TIMEOUT_MS);

  blockedPlayback = {
    audioData,
    localResolve,
    localToken,
    timeoutId,
    requestedAt: Date.now(),
  };

  logWarn("🔊 Audio playback blocked by autoplay policy — waiting for user gesture");
}

function retryBlockedPlayback(): void {
  if (!blockedPlayback) return;

  const { audioData, localResolve, localToken, requestedAt } = blockedPlayback;
  if (localToken !== playbackToken || playbackResolve !== localResolve) {
    clearBlockedPlayback("stale", false);
    return;
  }

  logDebug(`🔊 Retrying blocked playback after ${Date.now() - requestedAt}ms`);
  if (blockedPlayback?.timeoutId !== null) {
    clearTimeout(blockedPlayback.timeoutId);
  }
  blockedPlayback = null;
  playViaAudioElement(audioData, localResolve, localToken);
}

async function decodeAudioData(ctx: AudioContext, arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
  return await new Promise<AudioBuffer>((resolve, reject) => {
    try {
      ctx.decodeAudioData(
        arrayBuffer.slice(0),
        (buffer) => resolve(buffer),
        (err) => reject(err)
      );
    } catch (e) {
      reject(e);
    }
  });
}

// ============================================================================
// User-gesture AudioContext resume
// ============================================================================

/**
 * Set up a one-time user gesture listener to eagerly resume the AudioContext.
 * Browsers block AudioContext.start() unless triggered by a user gesture.
 * Call this once during app initialization so that by the time playAudio() is
 * invoked from an RPC handler, the context is already in the "running" state.
 */
export function initAudioContextOnUserGesture(): void {
  const events = ["click", "touchstart", "pointerdown", "keydown"] as const;

  const handler = async (): Promise<void> => {
    // Remove all listeners immediately so we only do this once
    for (const evt of events) {
      document.removeEventListener(evt, handler, true);
    }

    try {
      const ctx = await ensureAudioContext();
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      if (ctx.state === "running") {
        logDebug("🔊 AudioContext resumed after user gesture — switching from fallback");
        usingFallback = false;
      } else {
        logDebug(`🔊 AudioContext state after gesture: ${ctx.state}`);
      }
      retryBlockedPlayback();
    } catch (e) {
      logWarn("Failed to resume AudioContext on user gesture:", e);
    }
  };

  for (const evt of events) {
    document.addEventListener(evt, handler, { capture: true });
  }

  logDebug("🔊 Registered user-gesture AudioContext resume listeners");
}

// ============================================================================
// Fallback: HTML <audio> element playback
// ============================================================================

/**
 * Play audio using an HTML <audio> element (no AudioContext needed).
 * This bypasses the autoplay policy in many Chromium configurations.
 */
function playViaAudioElement(
  audioData: string,
  localResolve: () => void,
  localToken: number
): void {
  const audio = new Audio();

  // Set volume before loading
  audio.volume = isMuted ? 0 : clamp01(currentVolume * currentChunkVolume);

  audio.onended = () => {
    if (currentAudioElement === audio) {
      currentAudioElement = null;
      if (playbackResolve === localResolve) {
        playbackResolve = null;
        localResolve();
      }
    }
  };

  audio.onerror = (e) => {
    logWarn("🔊 <audio> element playback error:", e);
    if (currentAudioElement === audio) {
      currentAudioElement = null;
    }
    if (playbackResolve === localResolve) {
      playbackResolve = null;
      localResolve();
    }
  };

  currentAudioElement = audio;
  audio.src = audioData;

  audio.play().catch((err) => {
    if (isAutoplayBlockedError(err)) {
      if (currentAudioElement === audio) {
        currentAudioElement = null;
      }
      registerBlockedPlayback(audioData, localResolve, localToken);
      return;
    }

    logWarn("🔊 <audio> element play() rejected:", err);
    if (currentAudioElement === audio) {
      currentAudioElement = null;
    }
    if (playbackResolve === localResolve) {
      playbackResolve = null;
      localResolve();
    }
  });
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Set the avatar reference for state updates
 */
export function setAvatarRef(_avatar: unknown): void {
  // No-op: avatar state should be controlled by backend `setState` messages,
  // not by the audio player (which only handles audio and promise resolution).
}

/**
 * Set mute state
 */
export function setMuted(muted: boolean): void {
  isMuted = muted;
  logDebug(`🔇 setMuted(${muted})`);
  applyEffectiveGain();
  applyFallbackVolume();
}

/**
 * Get mute state
 */
export function getMuted(): boolean {
  return isMuted;
}

/**
 * Set global volume (0..1). This is independent of mute state.
 */
export function setVolume(volume01: number): void {
  currentVolume = clamp01(volume01);
  logDebug(`🔊 setVolume(${currentVolume})`);
  applyEffectiveGain();
  applyFallbackVolume();
}

/**
 * Get global volume (0..1).
 */
export function getVolume(): number {
  return currentVolume;
}

/**
 * Stop current audio playback (both AudioContext source and <audio> element)
 */
export function stopAudio(): void {
  playbackToken++;
  clearBlockedPlayback("stopAudio");

  // Stop AudioContext source
  if (currentSource) {
    try {
      currentSource.onended = null;
      currentSource.stop(0);
    } catch (e) {
      logDebug("Error stopping AudioBufferSourceNode:", e);
    }
    try {
      currentSource.disconnect();
    } catch {
      // ignore
    }
    currentSource = null;
  }

  // Stop <audio> element
  if (currentAudioElement) {
    try {
      currentAudioElement.onended = null;
      currentAudioElement.onerror = null;
      currentAudioElement.pause();
      currentAudioElement.src = "";
    } catch (e) {
      logDebug("Error stopping <audio> element:", e);
    }
    currentAudioElement = null;
  }

  currentChunkVolume = 1.0;

  // Resolve any pending playback promise so the backend queue doesn't hang
  if (playbackResolve) {
    const resolve = playbackResolve;
    playbackResolve = null;
    resolve();
  }
}

/**
 * Suppress any new playback until cleared (used for interrupts).
 */
export function suppressPlayback(): void {
  playbackSuppressed = true;
  stopAudio();
}

/**
 * Allow playback again (used when a new response begins).
 */
export function clearPlaybackSuppression(): void {
  playbackSuppressed = false;
}

/**
 * Play audio from base64 data URL.
 * Tries AudioContext first; if it's suspended (autoplay policy), falls back
 * to an HTML <audio> element which often works in Chromium without user gesture.
 */
export async function playAudio(audioData: string, volume: number = 1.0, rate: number = 1.7): Promise<void> {
  if (playbackSuppressed) {
    stopAudio();
    logDebug("🔇 playAudio suppressed (interrupt in effect)");
    return;
  }

  // Stop current audio (this will resolve any pending promise)
  stopAudio();
  clearBlockedPlayback("new playAudio");

  return new Promise((resolve) => {
    playbackResolve = resolve;
    const localResolve = resolve;
    const localToken = ++playbackToken;

    // We intentionally ignore rate (WebAudio-only normal-speed playback).
    // Keep signature for RPC compatibility.
    if (rate !== 1.0) {
      logDebug(`🔊 playAudio ignoring rate=${rate} (WebAudio-only normal speed)`);
    }

    const requestedChunkVolume = clamp01(volume);

    /**
     * Attempt AudioContext-based playback.
     * Returns true if we successfully started playing, false if AudioContext
     * is suspended and we should fall back.
     */
    const attemptWebAudio = async (attempt: number): Promise<boolean> => {
      try {
        const ctx = await ensureAudioContext();

        // If the context is still suspended after resume attempt, fall back immediately.
        // Don't waste time decoding audio that can't play.
        if (ctx.state === "suspended") {
          logDebug("🔊 AudioContext suspended — will use <audio> fallback");
          return false;
        }

        currentChunkVolume = requestedChunkVolume;
        applyEffectiveGain();

        // Fetch and decode audio data ("data:audio/wav;base64,...")
        const response = await fetch(audioData);
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await decodeAudioData(ctx, arrayBuffer);

        // If we were stopped while decoding, don't start playing
        if (localToken !== playbackToken || playbackResolve !== localResolve) {
          return true; // Don't fall back — we were explicitly stopped
        }

        // Re-check context state after async decode
        if (ctx.state === "suspended") {
          logDebug("🔊 AudioContext became suspended during decode — falling back");
          return false;
        }

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.playbackRate.value = 1.0;

        source.onended = () => {
          if (currentSource === source) {
            currentSource = null;
            if (playbackResolve === localResolve) {
              playbackResolve = null;
              localResolve();
            }
          }
        };

        currentSource = source;
        source.connect(masterGainNode!);
        source.start(0);
        return true;
      } catch (err) {
        if (attempt === 0) {
          logWarn("WebAudio play failed, recreating AudioContext and retrying once:", err);
          try {
            await recreateAudioContextForRetry();
            try {
              const ctx = await ensureAudioContext();
              if (ctx.state === "suspended") await ctx.resume();
            } catch {
              // ignore
            }
            return attemptWebAudio(1);
          } catch (e) {
            logError("AudioContext recreate failed:", e);
            return false;
          }
        }

        logWarn("WebAudio play failed after retry, falling back to <audio>:", err);
        return false;
      }
    };

    (async () => {
      try {
        // If we already know AudioContext is broken, skip straight to fallback
        let usedWebAudio = false;
        if (!usingFallback) {
          usedWebAudio = await attemptWebAudio(0);
          if (!usedWebAudio) {
            usingFallback = true;
            logDebug("🔊 Switching to <audio> element fallback for this and future chunks");
          }
        }

        if (!usedWebAudio) {
          // Check we weren't stopped while attempting WebAudio
          if (localToken !== playbackToken || playbackResolve !== localResolve) {
            return;
          }
          currentChunkVolume = requestedChunkVolume;
          playViaAudioElement(audioData, localResolve, localToken);
        }
      } catch (err) {
        logError("Unexpected playAudio failure:", err);
        if (playbackResolve === localResolve) {
          playbackResolve = null;
          localResolve();
        }
      }
    })();
  });
}

/**
 * Get current audio state
 */
export function isPlaying(): boolean {
  return currentSource !== null || currentAudioElement !== null;
}

/**
 * Close and cleanup the AudioContext
 */
export async function closeAudioContext(): Promise<void> {
  stopAudio();

  if (masterGainNode) {
    try {
      masterGainNode.disconnect();
    } catch (e) {
      logDebug("Error disconnecting master gain:", e);
    }
    masterGainNode = null;
  }

  if (audioContext) {
    try {
      if (audioContext.state !== "closed") {
        await audioContext.close();
        logDebug("🔊 AudioContext closed");
      }
    } catch (error) {
      logWarn("Failed to close AudioContext:", error);
    }
    audioContext = null;
  }
}
