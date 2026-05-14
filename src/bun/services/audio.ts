/**
 * Audio Service
 * Handles audio playback and queue management for TTS
 */

import { tmpdir } from "os";
import { join } from "path";
import { logDebug, logWarn, logError } from "../utils/logger";

// Track currently playing audio process to prevent overlap
let currentAudioProc: ReturnType<typeof import("bun").spawn> | null = null;
let currentFfmpegProc: ReturnType<typeof import("bun").spawn> | null = null;
let isMuted: boolean = false;

/**
 * Set mute state for backend playback
 */
export function setMuted(muted: boolean): void {
  isMuted = muted;
  if (muted) {
    stopCurrentAudio();
  }
}

/**
 * Get mute state for backend playback
 */
export function getMuted(): boolean {
  return isMuted;
}

/**
 * Stop any currently playing audio
 * Uses SIGKILL for immediate termination
 */
export function stopCurrentAudio(): void {
  console.log("🔇 stopCurrentAudio called, currentAudioProc:", currentAudioProc ? "exists" : "null");

  if (currentFfmpegProc) {
    try {
      currentFfmpegProc.kill(9);
      console.log("🔇 Killed currentFfmpegProc with SIGKILL");
    } catch (e) {
      console.log("🔇 Failed to kill currentFfmpegProc:", e);
    }
    currentFfmpegProc = null;
  }

  if (currentAudioProc) {
    try {
      // Use SIGKILL (9) for immediate termination - no buffered audio continuation
      currentAudioProc.kill(9);
      console.log("🔇 Killed currentAudioProc with SIGKILL");
    } catch (e) {
      console.log("🔇 Failed to kill currentAudioProc:", e);
    }
    currentAudioProc = null;
  }
}

/**
 * Safely delete a temp file
 */
function safeUnlink(filepath: string): void {
  try {
    const { unlinkSync } = require("fs");
    unlinkSync(filepath);
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Play audio locally using system audio with speed and pitch adjustment
 * @param audioData - Base64 encoded WAV audio data
 * @param rate - Playback speed multiplier (1.0 = normal, 1.4 = 40% faster)
 * @param pitchShift - Pitch shift in semitones (1.0 = no change, 1.05 = 5% higher)
 */
export async function playAudioLocally(
  audioData: string,
  rate: number = 1.25,
  pitchShift: number = 1.0
): Promise<void> {
  // Respect mute state
  if (isMuted) {
    logDebug("🔇 playAudioLocally skipped (muted)");
    return;
  }

  // Stop any currently playing audio first
  stopCurrentAudio();

  try {
    // audioData is "data:audio/wav;base64,..."
    const base64Data = audioData.split(",")[1];
    const wavBuffer = Buffer.from(base64Data, "base64");

    // Save to temp file (cross-platform)
    let tempFile = join(tmpdir(), `ai-secretary-tts-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);
    await Bun.write(tempFile, wavBuffer);

    const { spawn } = await import("bun");

    const ffmpegPath = typeof Bun.which === "function" ? Bun.which("ffmpeg") : null;
    if ((rate !== 1.0 || pitchShift !== 1.0) && ffmpegPath) {
      // Use ffmpeg for speed and pitch adjustment
      const processedFile = `${tempFile}-processed.wav`;
      const filters: string[] = [];

      if (pitchShift !== 1.0) {
        const originalRate = 22050;
        const shiftedRate = Math.round(originalRate * pitchShift);
        filters.push(`asetrate=${shiftedRate}`);
        filters.push(`aresample=${originalRate}`);
      }

      if (rate !== 1.0) {
        filters.push(`atempo=${rate}`);
      }

      const filterString = filters.join(",");
      const ffmpegProc = spawn([ffmpegPath, "-i", tempFile, "-filter:a", filterString, "-y", processedFile], {
        stdout: "pipe",
        stderr: "pipe",
      });
      currentFfmpegProc = ffmpegProc;

      await ffmpegProc.exited;
      if (currentFfmpegProc === ffmpegProc) {
        currentFfmpegProc = null;
      }

      // Check mute state again after ffmpeg (it might have taken a while)
      if (isMuted) {
        logDebug("🔇 playAudioLocally skipped after ffmpeg (muted)");
        safeUnlink(tempFile);
        safeUnlink(processedFile);
        return;
      }

      if (ffmpegProc.exitCode !== 0) {
        logWarn("ffmpeg failed, playing original");
      } else {
        safeUnlink(tempFile);
        tempFile = processedFile;
      }
    }

    // Platform-specific playback
    const platform = process.platform;

    async function spawnPlayer(cmd: string[], label: string) {
      try {
        const proc = spawn(cmd, { stdout: "pipe", stderr: "pipe" });
        currentAudioProc = proc;
        logDebug(`🔊 Playing audio (${label}): ${tempFile}`);
        const exitCode = await proc.exited;
        const stderr = exitCode !== 0 ? await new Response(proc.stderr).text() : "";
        return { proc, exitCode, stderr };
      } catch (e) {
        return { proc: null as any, exitCode: 127, stderr: String(e) };
      }
    }

    let playback: { proc: any; exitCode: number; stderr: string };
    if (platform === "win32") {
      const psPath = tempFile.replace(/'/g, "''");
      playback = await spawnPlayer(
        [
          "powershell",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(New-Object System.Media.SoundPlayer '${psPath}').PlaySync()`,
        ],
        "powershell"
      );
    } else if (platform === "darwin") {
      playback = await spawnPlayer(["afplay", tempFile], "afplay");
    } else {
      playback = await spawnPlayer(["aplay", tempFile], "aplay");
      if (playback.exitCode !== 0) {
        playback = await spawnPlayer(["paplay", tempFile], "paplay");
      }
    }

    const exitCode = playback.exitCode;
    if (exitCode !== 0) {
      logWarn(`Audio player exited with code ${exitCode}: ${playback.stderr}`);
    } else {
      logDebug("🔊 Audio playback complete");
    }

    if (currentAudioProc && playback.proc && currentAudioProc === playback.proc) {
      currentAudioProc = null;
    }

    if (exitCode === 0) {
      setTimeout(() => safeUnlink(tempFile), 500);
    }
  } catch (error) {
    logWarn("Failed to play audio locally:", error);
    currentAudioProc = null;
    currentFfmpegProc = null;
  }
}

/**
 * Audio Queue Item interface
 */
export interface AudioQueueItem {
  audioData: string;
  id: number;
  queuedAt: number;
  text?: string;
}

/**
 * Audio Queue callbacks interface
 */
export interface AudioQueueCallbacks {
  onPlaybackStart?: () => void;
  onPlaybackComplete?: (item: AudioQueueItem) => void;
  onQueueEmpty?: () => void;
  onChunkStarted?: (item: AudioQueueItem) => void;
  onQueueLow?: () => void;
  /** Custom playback function (e.g. via RPC to webview) */
  playAudio?: (audioData: string) => Promise<void>;
}

/**
 * Audio Queue Manager for streaming TTS playback
 * Handles sequential playback of audio chunks with proper cancellation
 */
export class AudioQueue {
  private queue: AudioQueueItem[] = [];
  private isPlaying: boolean = false;
  private isCancelled: boolean = false;
  private itemId: number = 0;
  private onPlaybackStart?: () => void;
  private onPlaybackComplete?: (item: AudioQueueItem) => void;
  private onQueueEmpty?: () => void;
  private onChunkStarted?: (item: AudioQueueItem) => void;
  private onQueueLow?: () => void;
  private playAudioCallback?: (audioData: string) => Promise<void>;

  constructor(callbacks?: AudioQueueCallbacks) {
    this.onPlaybackStart = callbacks?.onPlaybackStart;
    this.onPlaybackComplete = callbacks?.onPlaybackComplete;
    this.onQueueEmpty = callbacks?.onQueueEmpty;
    this.onChunkStarted = callbacks?.onChunkStarted;
    this.onQueueLow = callbacks?.onQueueLow;
    this.playAudioCallback = callbacks?.playAudio;
  }

  /**
   * Add audio to the queue and start playing if not already
   */
  enqueue(audioData: string, text?: string): void {
    if (this.isCancelled) return;

    const queuedAt = Date.now();
    this.queue.push({ audioData, id: ++this.itemId, queuedAt, text });
    logDebug(`🎵 Audio queued (id: ${this.itemId}, queue size: ${this.queue.length})`);

    if (!this.isPlaying) {
      this.processQueue();
    }
  }

  /**
   * Process the next item in the queue
   */
  private async processQueue(): Promise<void> {
    if (this.isCancelled) {
      this.isPlaying = false;
      return;
    }

    if (this.queue.length === 0) {
      this.isPlaying = false;
      this.onQueueEmpty?.();
      return;
    }

    this.isPlaying = true;
    const item = this.queue.shift()!;
    const queuedForMs = Date.now() - item.queuedAt;

    if (this.isCancelled) {
      this.isPlaying = false;
      return;
    }

    if (item.id === 1) {
      this.onPlaybackStart?.();
    }

    this.onChunkStarted?.(item);

    if (this.queue.length <= 1) {
      this.onQueueLow?.();
    }

    try {
      logDebug(`🔊 Playing audio chunk (id: ${item.id}, remaining: ${this.queue.length}, queuedForMs: ${queuedForMs})`);

      if (this.playAudioCallback) {
        await this.playAudioCallback(item.audioData);
      } else {
        await playAudioLocally(item.audioData, 1.25, 1.05);
      }

      if (this.isCancelled) {
        this.isPlaying = false;
        return;
      }

      this.onPlaybackComplete?.(item);
    } catch (error) {
      logWarn("Audio playback error:", error);
      if (this.isCancelled) {
        this.isPlaying = false;
        return;
      }
    }

    if (!this.isCancelled) {
      this.processQueue();
    } else {
      this.isPlaying = false;
    }
  }

  /**
   * Cancel all pending audio and stop current playback
   */
  cancel(): void {
    this.isCancelled = true;
    this.queue = [];
    this.isPlaying = false;
    stopCurrentAudio();
    logDebug("🛑 Audio queue cancelled");
  }

  /**
   * Reset the queue for a new session
   */
  reset(): void {
    this.cancel();
    this.isCancelled = false;
    this.itemId = 0;
  }

  /**
   * Check if queue is empty and not playing
   */
  isEmpty(): boolean {
    return this.queue.length === 0 && !this.isPlaying;
  }

  /**
   * Check if cancelled
   */
  wasCancelled(): boolean {
    return this.isCancelled;
  }

  /**
   * Get current queue size
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Check if audio is currently playing
   */
  isCurrentlyPlaying(): boolean {
    return this.isPlaying;
  }
}

/**
 * Clean text for TTS
 */
export function cleanTextForTTS(text: string): string {
  return text
    .replace(/\*/g, "")
    .replace(/~/g, "")
    .trim();
}
