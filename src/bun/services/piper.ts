/**
 * Piper TTS Service
 * Closure-based functional module for managing Piper TTS
 */

import { spawn, type Subprocess } from "bun";
import {
  isPiperInstalled,
  isVoiceModelInstalled,
  downloadPiper,
  downloadVoiceModel,
  getPiperPath,
  getVoiceModelPath,
} from "../utils/downloader";
import { logDebug, logWarn } from "../utils/logger";
import { parseWAVHeader, generateSilence, concatenateWAVs } from "../utils/wav";
import {
  estimateDuration,
  elongateVowels,
  removeEmojis,
  splitIntoSentences,
  stripSquareBracketSegments,
} from "../utils/textProcessing";

export interface TTSOptions {
  text: string;
  model?: string;
  volume?: number; // 0.0 to 1.0
}

export interface TTSResult {
  audioData: string; // base64 encoded WAV
  duration: number; // duration in seconds (estimated or parsed from WAV)
  sampleRate?: number; // Sample rate from WAV header
}

// Internal state interface
interface PiperState {
  piperPath: string | null;
  modelPath: string | null;
  isInitialized: boolean;
  currentProcess: Subprocess | null;
  isCancelled: boolean; // Flag to stop batch processing loops
}

// Piper TTS instance interface
export interface PiperTTSInstance {
  initialize: (onProgress?: (progress: string) => void) => Promise<void>;
  speak: (options: TTSOptions) => Promise<TTSResult>;
  /** Speak a batch of pre-split sentences (for streaming TTS) */
  speakBatch: (sentences: string[]) => Promise<TTSResult>;
  cancel: () => void;
  isReady: () => boolean;
  isGenerating: () => boolean;
  getModelPath: () => string | null;
  getPiperPath: () => string | null;
}

/**
 * Create a Piper TTS instance with closure-based state
 */
function createPiperTTS(): PiperTTSInstance {
  const state: PiperState = {
    piperPath: null,
    modelPath: null,
    isInitialized: false,
    currentProcess: null,
    isCancelled: false,
  };

  async function initialize(onProgress?: (progress: string) => void): Promise<void> {
    if (state.isInitialized) {
      return;
    }

    try {
      // Check if Piper is installed
      if (!(await isPiperInstalled())) {
        onProgress?.("Piper not found. Attempting download...");
        try {
          await downloadPiper(onProgress);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          onProgress?.(`Piper download failed: ${errorMsg}`);
          onProgress?.("TTS will be disabled. You can manually install Piper to your .ai-secretary/piper/ data directory.");
          // Don't throw - allow app to continue without TTS
          return;
        }
      }

      // Check if voice model is installed
      if (!(await isVoiceModelInstalled())) {
        onProgress?.("Voice model not found. Downloading...");
        try {
          await downloadVoiceModel(onProgress);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          onProgress?.(`Voice model download failed: ${errorMsg}`);
          onProgress?.("TTS will be disabled.");
          return;
        }
      }

      state.piperPath = await getPiperPath();
      state.modelPath = getVoiceModelPath();
      state.isInitialized = true;

      onProgress?.("Piper TTS ready");
    } catch (error) {
      if (error instanceof Error) {
        // Don't throw - allow app to continue without TTS
        onProgress?.(`Piper initialization warning: ${error.message}`);
        logWarn("Piper TTS will be disabled:", error);
      }
    }
  }

  /**
   * Process a single sentence through Piper
   */
  async function processSentence(sentence: string): Promise<ArrayBuffer> {
    if (!state.piperPath || !state.modelPath) {
      throw new Error("Piper not initialized");
    }

    // Spawn Piper process
    const proc = spawn(
      [
        state.piperPath,
        "--model",
        state.modelPath,
        "--output_file",
        "-", // Output to stdout as WAV
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    // Track process for cancellation
    state.currentProcess = proc;

    try {
      // Clean sentence: remove extra whitespace, keep single spaces
      const cleanedSentence = sentence.trim().replace(/\s+/g, " ");
      const textBytes = new TextEncoder().encode(cleanedSentence);
      await proc.stdin.write(textBytes);
      proc.stdin.end();

      // Read audio data from stdout
      const audioArrayBuffer = await new Response(proc.stdout).arrayBuffer();

      // Wait for process to finish
      const exitCode = await proc.exited;

      // Clear process tracking
      if (state.currentProcess === proc) {
        state.currentProcess = null;
      }

      if (exitCode !== 0) {
        const errorText = await new Response(proc.stderr)
          .arrayBuffer()
          .then((b) => new TextDecoder().decode(b));
        throw new Error(`Piper process failed with exit code ${exitCode}: ${errorText || "Unknown error"}`);
      }

      // Verify we got audio data
      if (audioArrayBuffer.byteLength < 44) {
        throw new Error("Piper returned insufficient audio data");
      }

      return audioArrayBuffer;
    } catch (error) {
      // Clear process tracking on error
      if (state.currentProcess === proc) {
        state.currentProcess = null;
      }
      throw error;
    }
  }

  async function speak(options: TTSOptions): Promise<TTSResult> {
    // Validate input
    if (!options.text || options.text.trim().length === 0) {
      throw new Error("Text cannot be empty");
    }

    if (!state.isInitialized) {
      await initialize();
    }

    if (!state.piperPath || !state.modelPath) {
      throw new Error("Piper not initialized. Please check that Piper binary and model are installed.");
    }

    // Cancel any ongoing TTS generation
    cancel();

    try {
      // Clean the text: remove formatting chars, elongate vowels, remove emojis, and normalize whitespace
      let cleanedText = stripSquareBracketSegments(options.text)
        .replace(/\n\s*\n/g, " ... ") // Add pause for paragraph breaks (double newlines)
        .replace(/[\r\n]+/g, " ") // Replace remaining newlines with spaces
        .replace(/\s+/g, " ") // Normalize whitespace
        .trim();

      // Elongate vowels before ~ (e.g., "nya~" -> "nyaaaa")
      cleanedText = elongateVowels(cleanedText);

      // Remove emojis
      cleanedText = removeEmojis(cleanedText)
        .replace(/\s+/g, " ") // Re-normalize whitespace after emoji removal
        .trim();

      if (!cleanedText) {
        throw new Error("No speakable text after cleaning");
      }

      // Split text into sentences for better handling of long text
      const sentences = splitIntoSentences(cleanedText);

      if (sentences.length === 0) {
        throw new Error("No sentences found after cleaning");
      }

      // Process each sentence separately and collect audio chunks
      const audioChunks: ArrayBuffer[] = [];
      let totalDuration = 0;
      let sampleRate: number | undefined;

      for (let i = 0; i < sentences.length; i++) {
        const sentence = sentences[i].trim();
        if (!sentence) continue;

        // Clean each sentence individually - remove formatting chars silently
        const sentenceCleaned = stripSquareBracketSegments(sentence)
          .replace(/\*/g, "") // Remove asterisks silently
          .replace(/~/g, "") // Remove tildes silently
          .replace(/\s+/g, " ")
          .trim();

        if (!sentenceCleaned) continue;

        try {
          const audioChunk = await processSentence(sentenceCleaned);
          audioChunks.push(audioChunk);

          // Parse WAV header to get duration and sample rate
          const wavInfo = parseWAVHeader(audioChunk);
          if (wavInfo) {
            totalDuration += wavInfo.duration;
            if (!sampleRate) {
              sampleRate = wavInfo.sampleRate;
            }
          }

          // Add a small pause between sentences (except for the last one)
          if (i < sentences.length - 1) {
            const pauseDuration = 0.3; // 300ms pause
            const pauseAudio = generateSilence(pauseDuration, sampleRate || 22050);
            audioChunks.push(pauseAudio);
            totalDuration += pauseDuration;
          }
        } catch (error) {
          // Log error but continue with other sentences
          logWarn(`Failed to process sentence "${sentence.substring(0, 50)}...":`, error);
        }
      }

      if (audioChunks.length === 0) {
        throw new Error("No audio was generated from any sentences");
      }

      // Concatenate all audio chunks
      const finalAudio = concatenateWAVs(audioChunks, 0); // Already added pauses above

      // Convert to base64
      const base64 = Buffer.from(finalAudio).toString("base64");
      const audioData = `data:audio/wav;base64,${base64}`;

      return {
        audioData,
        duration: totalDuration || estimateDuration(cleanedText),
        sampleRate: sampleRate || 22050,
      };
    } catch (error) {
      state.currentProcess = null;

      if (error instanceof Error) {
        // Check if it's a cancellation
        if (error.message.includes("cancelled") || error.message.includes("aborted")) {
          throw new Error("TTS generation was cancelled");
        }
        throw new Error(`TTS generation failed: ${error.message}`);
      }
      throw error;
    }
  }

  function cancel(): void {
    console.log("🎤 Piper cancel() called, currentProcess:", state.currentProcess ? "exists" : "null");

    // Set cancellation flag first - this stops batch loops
    state.isCancelled = true;
    console.log("🎤 Piper isCancelled set to true");

    if (state.currentProcess) {
      try {
        state.currentProcess.kill(9); // SIGKILL for immediate termination
        console.log("🎤 Piper process killed with SIGKILL");
        state.currentProcess = null;
      } catch (error) {
        logWarn("Failed to cancel TTS process:", error);
        console.log("🎤 Failed to kill piper process:", error);
        state.currentProcess = null;
      }
    }
  }

  /**
   * Speak a batch of pre-split sentences (for streaming TTS)
   * This skips the sentence splitting step since sentences are already provided.
   */
  async function speakBatch(sentences: string[]): Promise<TTSResult> {
    if (!sentences || sentences.length === 0) {
      throw new Error("No sentences provided");
    }

    if (!state.isInitialized) {
      await initialize();
    }

    if (!state.piperPath || !state.modelPath) {
      throw new Error("Piper not initialized. Please check that Piper binary and model are installed.");
    }

    // Reset cancellation flag at the start of a new batch
    state.isCancelled = false;

    try {
      // Pre-filter sentences: clean and remove empty ones before processing
      const validSentences: Array<{ original: string; cleaned: string }> = [];

      for (const sentence of sentences) {
        const trimmed = stripSquareBracketSegments(sentence).trim();
        if (!trimmed) continue;

        // Clean the sentence: add pauses for paragraphs, elongate vowels, remove formatting chars, remove emojis
        let cleanedSentence = trimmed
          .replace(/\n\s*\n/g, " ... ") // Add pause for paragraph breaks (double newlines)
          .replace(/[\r\n]+/g, " ") // Replace remaining newlines with spaces
          .replace(/\s+/g, " ") // Normalize whitespace
          .trim();

        // Elongate vowels before ~ (e.g., "nya~" -> "nyaaaa")
        // This also removes the ~ after elongation
        cleanedSentence = elongateVowels(cleanedSentence);

        // Remove any remaining formatting characters silently (asterisks, tildes)
        // These shouldn't be spoken as "asterisk" or "tilde"
        cleanedSentence = cleanedSentence
          .replace(/\*/g, "") // Remove asterisks
          .replace(/~/g, ""); // Remove any remaining tildes

        // Remove emojis
        cleanedSentence = removeEmojis(cleanedSentence).replace(/\s+/g, " ").trim();

        if (cleanedSentence) {
          validSentences.push({ original: trimmed, cleaned: cleanedSentence });
        }
      }

      // If no valid sentences after cleaning, return silently (not an error)
      if (validSentences.length === 0) {
        logDebug("TTS: All sentences were empty after cleaning (likely only action descriptions)");
        // Return minimal silence audio to avoid errors
        const silenceAudio = generateSilence(0.1, 22050);
        const base64 = Buffer.from(silenceAudio).toString("base64");
        return {
          audioData: `data:audio/wav;base64,${base64}`,
          duration: 0.1,
          sampleRate: 22050,
        };
      }

      // Process each valid sentence separately and collect audio chunks
      const audioChunks: ArrayBuffer[] = [];
      let totalDuration = 0;
      let sampleRate: number | undefined;

      for (let i = 0; i < validSentences.length; i++) {
        // Check for cancellation before processing each sentence
        if (state.isCancelled) {
          logDebug("TTS batch cancelled, stopping sentence processing");
          break;
        }

        const { cleaned: cleanedSentence, original: originalSentence } = validSentences[i];

        try {
          const audioChunk = await processSentence(cleanedSentence);

          // Check for cancellation after processing (in case it was cancelled during)
          if (state.isCancelled) {
            logDebug("TTS batch cancelled after sentence processing");
            break;
          }

          audioChunks.push(audioChunk);

          // Parse WAV header to get duration and sample rate
          const wavInfo = parseWAVHeader(audioChunk);
          if (wavInfo) {
            totalDuration += wavInfo.duration;
            if (!sampleRate) {
              sampleRate = wavInfo.sampleRate;
            }
          }

          // Add a small pause between sentences (except for the last one)
          if (i < validSentences.length - 1) {
            const pauseDuration = 0.3; // 300ms pause
            const pauseAudio = generateSilence(pauseDuration, sampleRate || 22050);
            audioChunks.push(pauseAudio);
            totalDuration += pauseDuration;
          }
        } catch (error) {
          // If cancelled, stop the loop instead of continuing
          if (state.isCancelled) {
            logDebug("TTS batch cancelled (error during processing)");
            break;
          }
          // Log error but continue with other sentences
          logWarn(`Failed to process sentence "${originalSentence.substring(0, 50)}...":`, error);
        }
      }

      if (audioChunks.length === 0) {
        // This shouldn't happen since we pre-filtered, but handle gracefully
        logDebug("TTS: No audio chunks generated (unexpected)");
        const silenceAudio = generateSilence(0.1, 22050);
        const base64 = Buffer.from(silenceAudio).toString("base64");
        return {
          audioData: `data:audio/wav;base64,${base64}`,
          duration: 0.1,
          sampleRate: 22050,
        };
      }

      // Concatenate all audio chunks
      const finalAudio = concatenateWAVs(audioChunks, 0); // Already added pauses above

      // Convert to base64
      const base64 = Buffer.from(finalAudio).toString("base64");
      const audioData = `data:audio/wav;base64,${base64}`;

      // Estimate duration from all valid sentences if WAV parsing failed
      const estimatedDuration = validSentences.reduce((sum, s) => sum + estimateDuration(s.cleaned), 0);

      return {
        audioData,
        duration: totalDuration || estimatedDuration,
        sampleRate: sampleRate || 22050,
      };
    } catch (error) {
      state.currentProcess = null;

      if (error instanceof Error) {
        if (error.message.includes("cancelled") || error.message.includes("aborted")) {
          throw new Error("TTS generation was cancelled");
        }
        throw new Error(`TTS batch generation failed: ${error.message}`);
      }
      throw error;
    }
  }

  return {
    initialize,
    speak,
    speakBatch,
    cancel,
    isReady: () => state.isInitialized,
    isGenerating: () => state.currentProcess !== null,
    getModelPath: () => state.modelPath,
    getPiperPath: () => state.piperPath,
  };
}

// Singleton via lazy initialization
let _tts: PiperTTSInstance | null = null;

export function getPiperTTS(): PiperTTSInstance {
  if (!_tts) {
    _tts = createPiperTTS();
  }
  return _tts;
}

// Legacy export for backwards compatibility
export const piperTTS = new Proxy({} as PiperTTSInstance, {
  get(_target, prop) {
    return getPiperTTS()[prop as keyof PiperTTSInstance];
  },
});
