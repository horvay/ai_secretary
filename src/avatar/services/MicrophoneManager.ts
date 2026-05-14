/**
 * Microphone Manager
 * Unified manager for microphone capture, VAD, state machine, and UI indicator.
 * Consolidates logic that was previously scattered across multiple files.
 */

import { logDebug, logWarn, logError, logInfo } from "../utils/logger";

// ============================================================================
// Types
// ============================================================================

export type MicState = "stopped" | "starting" | "listening" | "stopping";

export type IndicatorState = "off" | "listening" | "followup" | "recording" | "transcribing";

export interface MicrophoneManagerConfig {
  speechThreshold?: number;
  silenceThreshold?: number;
  silenceDuration?: number;
  sampleRate?: number;
  maxRecordingDuration?: number;
  indicatorElementId?: string;
}

export interface MicrophoneManager {
  // Lifecycle
  start(): Promise<boolean>;
  stop(): boolean;
  toggle(): Promise<void>;

  // State
  getState(): MicState;
  isListening(): boolean;
  isEnabled(): boolean;

  // Events
  onSpeechStart(callback: () => void): void;
  onSpeechEnd(callback: (audioBuffer: Float32Array) => void): void;
  onError(callback: (error: Error) => void): void;
  onStateChange(callback: (from: MicState, to: MicState) => void): void;

  // UI Indicator
  setIndicatorState(state: IndicatorState): void;

  // Dynamic settings (for TTS barge-in mode)
  setSilenceDuration(ms: number): void;
  setMaxRecordingDuration(ms: number): void;
  setSpeechThreshold(threshold: number): void;
  setSilenceThreshold(threshold: number): void;

  // Cleanup
  destroy(): void;
}

// ============================================================================
// Constants
// ============================================================================

const MIC_ENABLED_KEY = "ari_mic_enabled";

// Valid state transitions
const VALID_TRANSITIONS: Record<MicState, MicState[]> = {
  stopped: ["starting"],
  starting: ["listening", "stopped"], // Can fail to start -> stopped
  listening: ["stopping"],
  stopping: ["stopped"],
};

// ============================================================================
// Internal State
// ============================================================================

interface MicrophoneInternalState {
  // Audio capture
  stream: MediaStream | null;
  audioContext: AudioContext | null;
  analyser: AnalyserNode | null;
  processor: ScriptProcessorNode | null;
  source: MediaStreamAudioSourceNode | null;
  isRecording: boolean;
  audioBuffer: Float32Array[];

  // State machine
  micState: MicState;

  // User preference
  enabledByUser: boolean;

  // VAD settings
  speechThreshold: number;
  silenceThreshold: number;
  silenceDuration: number;
  sampleRate: number;
  maxRecordingDuration: number;

  // VAD state
  lastSpeechTime: number;
  silenceStartTime: number | null;
  recordingStartTime: number | null;

  // Callbacks
  speechStartCallback: (() => void) | null;
  speechEndCallback: ((audioBuffer: Float32Array) => void) | null;
  errorCallback: ((error: Error) => void) | null;
  stateChangeCallbacks: Array<(from: MicState, to: MicState) => void>;

  // UI
  indicatorElementId: string | null;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Calculate RMS (Root Mean Square) of audio samples
 */
function calculateRMS(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

// ============================================================================
// Factory
// ============================================================================

export function createMicrophoneManager(config?: MicrophoneManagerConfig): MicrophoneManager {
  const state: MicrophoneInternalState = {
    // Audio capture
    stream: null,
    audioContext: null,
    analyser: null,
    processor: null,
    source: null,
    isRecording: false,
    audioBuffer: [],

    // State machine
    micState: "stopped",

    // User preference - load from localStorage
    enabledByUser: localStorage.getItem(MIC_ENABLED_KEY) !== "false",

    // VAD settings with defaults
    speechThreshold: config?.speechThreshold ?? 0.01,
    silenceThreshold: config?.silenceThreshold ?? 0.005,
    silenceDuration: config?.silenceDuration ?? 1500,
    sampleRate: config?.sampleRate ?? 16000,
    maxRecordingDuration: config?.maxRecordingDuration ?? 60000,

    // VAD state
    lastSpeechTime: 0,
    silenceStartTime: null,
    recordingStartTime: null,

    // Callbacks
    speechStartCallback: null,
    speechEndCallback: null,
    errorCallback: null,
    stateChangeCallbacks: [],

    // UI
    indicatorElementId: config?.indicatorElementId ?? null,
  };

  // ============================================================================
  // State Machine
  // ============================================================================

  function canTransitionTo(newState: MicState): boolean {
    return VALID_TRANSITIONS[state.micState].includes(newState);
  }

  function transitionTo(newState: MicState): boolean {
    if (!canTransitionTo(newState)) {
      logWarn(`⚠️ Invalid mic transition: ${state.micState} -> ${newState}`);
      return false;
    }

    const from = state.micState;
    state.micState = newState;
    logDebug(`✓ Mic transition: ${from} -> ${newState}`);

    // Notify listeners
    for (const listener of state.stateChangeCallbacks) {
      try {
        listener(from, newState);
      } catch (err) {
        logWarn(`State change listener error: ${err}`);
      }
    }

    return true;
  }

  // ============================================================================
  // UI Indicator
  // ============================================================================

  function updateIndicator(indicatorState: IndicatorState): void {
    if (!state.indicatorElementId) return;

    const indicator = document.getElementById(state.indicatorElementId);
    if (!indicator) return;

    // Remove all state classes
    indicator.classList.remove("off", "listening", "followup", "recording", "transcribing", "hidden");

    // Add new state class
    indicator.classList.add(indicatorState);

    // Update title
    switch (indicatorState) {
      case "off":
        indicator.title = "Microphone Off (Click to Enable)";
        break;
      case "listening":
        indicator.title = "Microphone Listening (Click to Disable)";
        break;
      case "followup":
        indicator.title = "Follow-up Mode (Click to Disable)";
        break;
      case "recording":
        indicator.title = "Recording... (Click to Disable)";
        break;
      case "transcribing":
        indicator.title = "Transcribing... (Click to Disable)";
        break;
    }
  }

  // ============================================================================
  // Audio Capture
  // ============================================================================

  async function startCapture(): Promise<void> {
    try {
      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: state.sampleRate,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      state.stream = stream;

      // Create audio context
      const AudioContextClass =
        AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error("Web Audio API not supported");
      }

      const audioContext = new AudioContextClass({
        sampleRate: state.sampleRate,
      });
      state.audioContext = audioContext;

      // Create analyser for VAD
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;
      state.analyser = analyser;

      // Create script processor for audio capture
      const bufferSize = 4096;
      const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);
      state.processor = processor;

      // Create source from stream
      const source = audioContext.createMediaStreamSource(stream);
      state.source = source;

      // Resume audio context (required for autoplay policies)
      if (audioContext.state === "suspended") {
        await audioContext.resume();
        logDebug("🎤 Audio context resumed");
      }

      // Connect: source -> analyser -> processor -> destination
      source.connect(analyser);
      analyser.connect(processor);
      processor.connect(audioContext.destination);

      // Track callback calls for debugging
      let callbackCount = 0;
      let lastLogTime = Date.now();

      // Process audio data
      processor.onaudioprocess = (event) => {
        callbackCount++;
        const now = Date.now();

        if (state.micState !== "listening") {
          return;
        }

        const inputBuffer = event.inputBuffer;
        const inputData = inputBuffer.getChannelData(0);

        // Get current RMS level for VAD
        const rms = calculateRMS(inputData);

        // Log periodically to verify audio is flowing (every 2 seconds)
        if (now - lastLogTime > 2000) {
          logDebug(
            `🎤 Audio flowing - RMS: ${rms.toFixed(4)}, threshold: ${state.speechThreshold}, callbacks: ${callbackCount}, recording: ${state.isRecording}`
          );
          lastLogTime = now;
        }

        // Check for speech start
        if (!state.isRecording && rms > state.speechThreshold) {
          // Speech detected
          state.isRecording = true;
          state.audioBuffer = [];
          state.lastSpeechTime = now;
          state.silenceStartTime = null;
          state.recordingStartTime = now;

          logDebug("🎤 Speech detected, starting recording");
          state.speechStartCallback?.();
        }

        // If recording, buffer audio
        if (state.isRecording) {
          // Copy audio data to buffer
          const audioData = new Float32Array(inputData.length);
          audioData.set(inputData);
          state.audioBuffer.push(audioData);

          // Check if we've exceeded max recording duration
          const recordingDuration = state.recordingStartTime ? now - state.recordingStartTime : 0;
          const shouldEndDueToMaxDuration = recordingDuration >= state.maxRecordingDuration;

          if (shouldEndDueToMaxDuration) {
            logWarn(`🎤 Max recording duration (${state.maxRecordingDuration / 1000}s) reached, ending recording`);
          }

          // Update speech/silence detection
          let shouldEndDueToSilence = false;
          if (rms > state.speechThreshold) {
            // Still speech
            state.lastSpeechTime = now;
            state.silenceStartTime = null;
          } else if (rms < state.silenceThreshold) {
            // Silence detected
            if (state.silenceStartTime === null) {
              state.silenceStartTime = now;
            } else {
              const silenceDuration = now - state.silenceStartTime;
              if (silenceDuration >= state.silenceDuration) {
                shouldEndDueToSilence = true;
                logDebug("🎤 Silence detected, ending recording");
              }
            }
          }

          // End recording if silence or max duration reached
          if (shouldEndDueToSilence || shouldEndDueToMaxDuration) {
            // Concatenate all audio buffers
            const totalLength = state.audioBuffer.reduce((sum, buf) => sum + buf.length, 0);
            const concatenated = new Float32Array(totalLength);
            let offset = 0;
            for (const buf of state.audioBuffer) {
              concatenated.set(buf, offset);
              offset += buf.length;
            }

            // Reset state
            state.isRecording = false;
            state.audioBuffer = [];
            state.silenceStartTime = null;
            state.recordingStartTime = null;

            // Callback with audio buffer
            if (concatenated.length > 0) {
              state.speechEndCallback?.(concatenated);
            }
          }
        }
      };

      logDebug("🎤 Microphone listening started");
      logDebug(`🎤 Audio context state: ${audioContext.state}, sample rate: ${audioContext.sampleRate}`);
      logDebug(`🎤 VAD thresholds - speech: ${state.speechThreshold}, silence: ${state.silenceThreshold}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logError("🎤 Failed to start microphone:", errorMessage);
      state.errorCallback?.(new Error(`Microphone access failed: ${errorMessage}`));
      throw error;
    }
  }

  function stopCapture(): void {
    // Stop recording if active
    if (state.isRecording) {
      state.isRecording = false;
      state.audioBuffer = [];
      state.recordingStartTime = null;
    }

    // Disconnect audio nodes
    if (state.processor) {
      state.processor.disconnect();
      state.processor = null;
    }
    if (state.source) {
      state.source.disconnect();
      state.source = null;
    }
    if (state.analyser) {
      state.analyser.disconnect();
      state.analyser = null;
    }

    // Stop tracks
    if (state.stream) {
      state.stream.getTracks().forEach((track) => track.stop());
      state.stream = null;
    }

    // Close audio context
    if (state.audioContext) {
      state.audioContext.close().catch((err) => {
        logWarn("Failed to close audio context:", err);
      });
      state.audioContext = null;
    }

    logDebug("🎤 Microphone stopped");
  }

  // ============================================================================
  // Public API
  // ============================================================================

  async function start(): Promise<boolean> {
    if (!state.enabledByUser) {
      logDebug("🎤 Mic is disabled by user, not starting");
      updateIndicator("off");
      return false;
    }

    if (!transitionTo("starting")) {
      logDebug("🎤 Cannot start microphone (invalid state transition)");
      return false;
    }

    try {
      await startCapture();
      transitionTo("listening");
      updateIndicator("listening");
      return true;
    } catch (error) {
      transitionTo("stopped");
      updateIndicator("off");
      throw error;
    }
  }

  function stop(): boolean {
    if (!transitionTo("stopping")) {
      logDebug("🎤 Cannot stop microphone (invalid state transition)");
      return false;
    }

    stopCapture();
    transitionTo("stopped");
    updateIndicator("off");
    return true;
  }

  async function toggle(): Promise<void> {
    state.enabledByUser = !state.enabledByUser;
    localStorage.setItem(MIC_ENABLED_KEY, String(state.enabledByUser));

    logInfo(`🎤 Microphone toggled: ${state.enabledByUser ? "ON" : "OFF"}`);

    if (state.enabledByUser) {
      await start();
    } else {
      stop();
    }
  }

  function getState(): MicState {
    return state.micState;
  }

  function isListening(): boolean {
    return state.micState === "listening";
  }

  function isEnabled(): boolean {
    return state.enabledByUser;
  }

  function onSpeechStart(callback: () => void): void {
    state.speechStartCallback = callback;
  }

  function onSpeechEnd(callback: (audioBuffer: Float32Array) => void): void {
    state.speechEndCallback = callback;
  }

  function onError(callback: (error: Error) => void): void {
    state.errorCallback = callback;
  }

  function onStateChange(callback: (from: MicState, to: MicState) => void): void {
    state.stateChangeCallbacks.push(callback);
  }

  function setIndicatorState(indicatorState: IndicatorState): void {
    updateIndicator(indicatorState);
  }

  function setSilenceDuration(ms: number): void {
    state.silenceDuration = ms;
    logDebug(`🎤 Silence duration set to ${ms}ms`);
  }

  function setMaxRecordingDuration(ms: number): void {
    state.maxRecordingDuration = ms;
    logDebug(`🎤 Max recording duration set to ${ms}ms`);
  }

  function setSpeechThreshold(threshold: number): void {
    state.speechThreshold = threshold;
    logDebug(`🎤 Speech threshold set to ${threshold}`);
  }

  function setSilenceThreshold(threshold: number): void {
    state.silenceThreshold = threshold;
    logDebug(`🎤 Silence threshold set to ${threshold}`);
  }

  function destroy(): void {
    if (state.micState === "listening") {
      stop();
    }
    state.stateChangeCallbacks = [];
    state.speechStartCallback = null;
    state.speechEndCallback = null;
    state.errorCallback = null;
  }

  return {
    start,
    stop,
    toggle,
    getState,
    isListening,
    isEnabled,
    onSpeechStart,
    onSpeechEnd,
    onError,
    onStateChange,
    setIndicatorState,
    setSilenceDuration,
    setMaxRecordingDuration,
    setSpeechThreshold,
    setSilenceThreshold,
    destroy,
  };
}
