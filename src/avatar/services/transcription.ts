/**
 * Transcription Service
 * Handles parakeet.js model loading and audio transcription
 * Model files are downloaded via Bun backend and served locally
 */

import { type AISecretaryRPC } from "../../shared/rpc";
import { defineRPC } from "../electron-rpc";
import { logDebug, logError, logWarn } from "../utils/logger";

// Maximum audio buffer size we'll accept (90 seconds at 16kHz = 1,440,000 samples)
// Beyond this, WASM memory issues become likely
const MAX_AUDIO_SAMPLES = 90 * 16000; // 90 seconds at 16kHz sample rate

export interface TranscriptionInstance {
  initialize: (rpc: ReturnType<typeof defineRPC<AISecretaryRPC>>) => Promise<void>;
  transcribe: (audioBuffer: Float32Array) => Promise<string>;
  isReady: () => boolean;
  getStats: () => { transcriptionCount: number; errorCount: number; lastError: string | null };
}

interface TranscriptionState {
  worker: Worker | null;
  nextRequestId: number;
  pendingRequests: Map<number, { resolve: (value: string) => void; reject: (error: Error) => void }>;
  isInitialized: boolean;
  isInitializing: boolean;
  rpcRef: ReturnType<typeof defineRPC<AISecretaryRPC>> | null;
  transcriptionCount: number;
  errorCount: number;
  consecutiveErrors: number;
  lastError: string | null;
}

// Max consecutive errors before attempting reinit
const MAX_CONSECUTIVE_ERRORS = 3;

/**
 * Create a transcription instance with closure-based state
 */
export function createTranscription(): TranscriptionInstance {
  const state: TranscriptionState = {
    worker: null,
    nextRequestId: 0,
    pendingRequests: new Map(),
    isInitialized: false,
    isInitializing: false,
    rpcRef: null,
    transcriptionCount: 0,
    errorCount: 0,
    consecutiveErrors: 0,
    lastError: null,
  };

  function createWorker(): Worker {
    const worker = new Worker(new URL("./transcriptionWorker.js", import.meta.url), { type: "module" });

    worker.onmessage = (event: MessageEvent<{ id: number; type: string; text?: string; error?: string }>) => {
      const message = event.data;
      const pending = state.pendingRequests.get(message.id);
      if (!pending) return;

      state.pendingRequests.delete(message.id);
      if (message.type === "error") {
        pending.reject(new Error(message.error || "Unknown transcription worker error"));
      } else {
        pending.resolve(message.text || "");
      }
    };

    worker.onerror = (event) => {
      terminateWorker(new Error(event.message || "Transcription worker crashed."));
    };

    return worker;
  }

  function terminateWorker(error: Error): void {
    if (state.worker) {
      state.worker.terminate();
      state.worker = null;
    }
    for (const pending of state.pendingRequests.values()) {
      pending.reject(error);
    }
    state.pendingRequests.clear();
  }

  function workerRequest(
    worker: Worker,
    type: "init" | "transcribe" | "reset",
    payload: Record<string, unknown> = {},
    transfer: Transferable[] = [],
  ): Promise<string> {
    const id = ++state.nextRequestId;
    return new Promise((resolve, reject) => {
      state.pendingRequests.set(id, { resolve, reject });
      worker.postMessage({ id, type, ...payload }, transfer);
    });
  }

  async function initialize(rpc: ReturnType<typeof defineRPC<AISecretaryRPC>>, forceReinit: boolean = false): Promise<void> {
    if ((state.isInitialized || state.isInitializing) && !forceReinit) {
      logDebug("🎙️ Transcription already initialized or initializing, skipping");
      return;
    }

    // Store RPC reference for potential reinitialization
    state.rpcRef = rpc;

    // If reinitializing, clean up existing worker/model
    if (forceReinit && state.worker) {
      logWarn("🔄 Reinitializing transcription worker...");
      terminateWorker(new Error("Transcription worker is reinitializing."));
      state.isInitialized = false;
    }

    state.isInitializing = true;
    logDebug("🎙️ Initializing parakeet.js model...");
    logDebug("📥 Model files will be downloaded via Bun backend and cached on disk");

    try {
      // Use WASM backend (Chromium doesn't support WebGPU)
      const backend = "wasm";
      const encoderQuant = "int8";
      const decoderQuant = "int8";
      const preprocessor = "nemo128";

      logDebug("ℹ️ Using WASM backend (Chromium doesn't support WebGPU)");
      logDebug("📥 Requesting model files from Bun backend...");
      logDebug("📥 Files will be downloaded to disk and served locally (persists between runs)");

      // Get model URLs from Bun backend (downloads files to disk if needed)
      const modelData = await rpc.request.getParakeetModelUrls({
        encoderQuant,
        decoderQuant,
        preprocessor,
      });

      logDebug("✅ Model files ready (downloaded or cached on disk)");

      // Create model instance inside a Web Worker so WASM/ONNX work does not freeze Ari's renderer UI.
      logDebug("🔧 Creating transcription worker with WASM backend...");
      const worker = createWorker();
      await workerRequest(worker, "init", {
        urls: modelData.urls,
        filenames: modelData.filenames,
        cpuThreads: Math.max(1, (navigator.hardwareConcurrency || 8) - 2),
      });

      state.worker = worker;
      state.isInitialized = true;
      state.isInitializing = false;

      logDebug("✅ Parakeet.js model loaded successfully in transcription worker");
    } catch (error) {
      state.isInitializing = false;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logError("❌ Failed to load parakeet.js model:", errorMessage);
      logError("Error details:", error);

      // Provide more helpful error messages
      if (errorMessage.includes("Failed to fetch") || errorMessage.includes("NetworkError") || errorMessage.includes("fetch")) {
        const helpfulMessage = "Network error downloading model. " +
          "Possible causes:\n" +
          "1. No internet connection\n" +
          "2. HuggingFace is blocked or rate-limiting\n" +
          "3. Firewall blocking the connection\n\n" +
          "Please check your internet connection and try again.";
        logError("💡", helpfulMessage);
        throw new Error(helpfulMessage);
      }

      throw new Error(`Transcription initialization failed: ${errorMessage}`);
    }
  }

  async function transcribe(audioBuffer: Float32Array): Promise<string> {
    if (!state.isInitialized || !state.worker) {
      throw new Error("Transcription not initialized. Call initialize() first.");
    }

    // Validate buffer size to prevent WASM memory issues
    if (audioBuffer.length > MAX_AUDIO_SAMPLES) {
      const durationSecs = audioBuffer.length / 16000;
      const maxDurationSecs = MAX_AUDIO_SAMPLES / 16000;
      logWarn(`🎙️ Audio buffer too large (${durationSecs.toFixed(1)}s > ${maxDurationSecs}s max). Truncating...`);
      // Truncate to max size (take the last N samples to capture most recent speech)
      audioBuffer = audioBuffer.slice(-MAX_AUDIO_SAMPLES);
    }

    // Also reject extremely short buffers (less than 100ms of audio)
    const MIN_AUDIO_SAMPLES = 16000 * 0.1; // 100ms
    if (audioBuffer.length < MIN_AUDIO_SAMPLES) {
      logDebug(`🎙️ Audio buffer too short (${audioBuffer.length} samples < ${MIN_AUDIO_SAMPLES}), skipping`);
      return "";
    }

    const sampleCount = audioBuffer.length;

    try {
      const durationSecs = (sampleCount / 16000).toFixed(1);
      logDebug(`🎙️ Transcribing audio buffer (${sampleCount} samples, ~${durationSecs}s) [#${state.transcriptionCount + 1}]...`);

      const text = await workerRequest(state.worker, "transcribe", { audioBuffer }, [audioBuffer.buffer]);
      logDebug(`✅ Transcription #${state.transcriptionCount + 1}: "${text}"`);

      // Success - update stats
      state.transcriptionCount++;
      state.consecutiveErrors = 0;

      return text;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logError("❌ Transcription failed:", errorMessage);

      // Update error stats
      state.errorCount++;
      state.consecutiveErrors++;
      state.lastError = errorMessage;

      // Log diagnostic info
      logError(`📊 Transcription stats: ${state.transcriptionCount} successful, ${state.errorCount} errors, ${state.consecutiveErrors} consecutive`);
      logError(`📊 Buffer info: ${sampleCount} samples (${(sampleCount / 16000).toFixed(1)}s)`);

      // Check if it looks like a memory/buffer error (numeric-looking error message)
      const isWasmError = /^\d+$/.test(errorMessage);
      if (isWasmError) {
        logError(`💡 This looks like a WASM/ONNX internal error (code: ${errorMessage})`);
      }

      // If we've had too many consecutive errors, try to reinitialize the model
      if (state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS && state.rpcRef) {
        logWarn(`🔄 ${state.consecutiveErrors} consecutive errors - attempting model reinitialization...`);

        // Schedule reinitialization (don't await - let it happen in background)
        initialize(state.rpcRef, true).then(() => {
          logDebug("✅ Model reinitialized successfully after errors");
          state.consecutiveErrors = 0;
        }).catch((reinitError) => {
          logError("❌ Failed to reinitialize model:", reinitError);
        });
      }

      if (isWasmError) {
        throw new Error(`Transcription failed: WASM/ONNX error (code: ${errorMessage}). Will attempt recovery.`);
      }

      throw new Error(`Transcription failed: ${errorMessage}`);
    }
  }

  function isReady(): boolean {
    return state.isInitialized && state.worker !== null;
  }

  function getStats(): { transcriptionCount: number; errorCount: number; lastError: string | null } {
    return {
      transcriptionCount: state.transcriptionCount,
      errorCount: state.errorCount,
      lastError: state.lastError,
    };
  }

  return {
    initialize,
    transcribe,
    isReady,
    getStats,
  };
}

