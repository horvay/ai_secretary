import type { AvatarInstance } from "../components/avatar/types";
import type { ChatBubbleInstance } from "../components/ChatBubble";
import type { ToastInstance } from "../components/Toast";
import type { MicrophoneManager, IndicatorState } from "./MicrophoneManager";
import type { TranscriptionInstance } from "./transcription";
import { shouldDropAsVoiceNoise } from "./inputFilter";
import { createBargeInController } from "./bargeIn";
import { createInterruptHandler } from "./interrupt";

export interface VoiceInputPipelineDeps {
  avatar: AvatarInstance;
  chatBubble: ChatBubbleInstance;
  toast: ToastInstance;
  micManager: MicrophoneManager;
  transcription: TranscriptionInstance;
  // RPC interface - includes both context injection and interrupt
  electronRpc: {
    rpc: {
      request: {
        injectContext: (payload: { text: string }) => Promise<void>;
        interruptResponse: (payload: {}) => Promise<void>;
        logAudioTranscript: (payload: {
          source: "microphone" | "speaker";
          content: string;
          startedAt?: number;
          endedAt?: number;
          timestamp?: number;
          routedToAi?: boolean;
          durationMs?: number;
          sampleRate?: number;
          model?: string;
          captureBackend?: string;
          metadata?: Record<string, unknown>;
        }) => Promise<{ id: number | null }>;
        getMicrophoneSendToAi: (payload: {}) => Promise<{ enabled: boolean }>;
      };
      send: { voiceActivity: (payload: {}) => void };
    };
  };
  askQuestion: (
    text: string,
    includeScreenshot: boolean,
    activeWindowOnly: boolean,
    options?: { source?: "text" | "voice" | "routine" | "reminder" | "system"; voiceMode?: "normal" | "ari-decides" },
  ) => Promise<{ response: string; delivered: boolean; visibleText: boolean; audible: boolean }>;
  stopAudio: () => void;
  suppressPlayback: () => void;
  stopFlashing: () => void;
  responseHideTimeout: { current: number | null };
  errorHideTimeout: { current: number | null };
  logDebug: (message: string, ...args: unknown[]) => void;
  logInfo: (message: string, ...args: unknown[]) => void;
  logWarn: (message: string, ...args: unknown[]) => void;
  logError: (message: string, ...args: unknown[]) => void;
  isProcessingAI: { current: boolean };
}

export function createVoiceInputPipeline(deps: VoiceInputPipelineDeps) {
  const {
    avatar,
    chatBubble,
    toast,
    micManager,
    transcription,
    electronRpc,
    askQuestion,
    stopAudio,
    suppressPlayback,
    stopFlashing,
    responseHideTimeout,
    errorHideTimeout,
    logDebug,
    logInfo,
    logWarn,
    logError,
    isProcessingAI,
  } = deps;

  // State for microphone/transcription
  let isTranscribing: boolean = false;

  let ariDecidesActive: Promise<void> | null = null;
  let ariDecidesPending: { text: string } | null = null;
  let microphoneSendToAiCache: boolean = true;
  const ariDecidesCounters = {
    queued: 0,
    replaced: 0,
    responded: 0,
    noResponse: 0,
  };

  function isAriBusy(): boolean {
    return isProcessingAI.current || avatar.getState() === "talking" || avatar.getState() === "processing";
  }

  function schedulePendingAriDecidesDrain(): void {
    setTimeout(() => {
      const pending = ariDecidesPending;
      if (!pending || ariDecidesActive) return;
      if (isAriBusy()) {
        schedulePendingAriDecidesDrain();
        return;
      }
      ariDecidesPending = null;
      enqueueAriDecidesCandidate(pending.text);
    }, 500);
  }

  async function refreshMicrophoneSendToAi(): Promise<boolean> {
    try {
      const result = await electronRpc.rpc.request.getMicrophoneSendToAi({});
      microphoneSendToAiCache = result.enabled;
      return microphoneSendToAiCache;
    } catch (error) {
      logWarn("Failed to load microphone routing setting; defaulting to send-to-Ari:", error);
      microphoneSendToAiCache = true;
      return true;
    }
  }

  function enqueueAriDecidesCandidate(text: string): void {
    ariDecidesCounters.queued += 1;

    const run = async (candidateText: string) => {
      try {
        logInfo(`📝 Sending always-listening candidate to Ari: "${candidateText}"`);
        const result = await askQuestion(candidateText, false, false, {
          source: "voice",
          voiceMode: "ari-decides",
        });
        if (result?.delivered) ariDecidesCounters.responded += 1;
        else ariDecidesCounters.noResponse += 1;
      } catch (error) {
        logWarn("Always-listening candidate failed:", error);
      } finally {
        ariDecidesActive = null;
        const pending = ariDecidesPending;
        ariDecidesPending = null;
        if (pending) {
          enqueueAriDecidesCandidate(pending.text);
        }
      }
    };

    if (isAriBusy()) {
      if (ariDecidesPending) ariDecidesCounters.replaced += 1;
      ariDecidesPending = { text };
      logDebug(`📥 Ari is busy; keeping newest JSON voice candidate pending: "${text}"`);
      schedulePendingAriDecidesDrain();
      return;
    }

    if (ariDecidesActive) {
      if (ariDecidesPending) ariDecidesCounters.replaced += 1;
      ariDecidesPending = { text };
      logDebug(
        `📥 Queued/replaced always-listening pending candidate (${JSON.stringify(ariDecidesCounters)}): "${text}"`,
      );
      return;
    }

    ariDecidesActive = run(text);
  }

  // Transcription initialization state
  let transcriptionInitRequested: boolean = false;
  let transcriptionInitPromise: Promise<void> | null = null;

  // ============================================================================
  // Internal Controllers - Created with deferred reference to avoid circular deps
  // ============================================================================

  // Deferred reference for interruptAndResetUI (needed because barge-in calls interrupt,
  // but interrupt needs barge-in's stopBargeInTracking)
  const interruptRef = { current: null as ((reason: string) => Promise<void>) | null };

  // Create barge-in controller first, using deferred reference
  const bargeIn = createBargeInController({
    avatar,
    interruptAndResetUI: (reason: string) => interruptRef.current?.(reason) ?? Promise.resolve(),
    logDebug,
    logInfo,
  });

  // Forward references for functions that interrupt handler needs
  // (these are defined later in the file)
  let activateFollowupModeInternal: () => void;
  let restartMicrophoneListeningInternal: () => void;

  // Create interrupt handler, passing barge-in's stopBargeInTracking
  const interrupt = createInterruptHandler({
    avatar,
    chatBubble,
    electronRpc,
    stopAudio,
    suppressPlayback,
    stopBargeInTracking: bargeIn.stopBargeInTracking,
    activateFollowupMode: () => activateFollowupModeInternal(),
    restartMicrophoneListening: () => restartMicrophoneListeningInternal(),
    responseHideTimeout,
    errorHideTimeout,
    isProcessingAI,
    logInfo,
    logWarn,
  });

  // Wire up the deferred reference
  interruptRef.current = interrupt.interruptAndResetUI;

  // Aliases for internal use
  const startBargeInTracking = bargeIn.startBargeInTracking;
  const stopBargeInTracking = bargeIn.stopBargeInTracking;
  const interruptAndResetUI = interrupt.interruptAndResetUI;
  const getLastInterruptTime = interrupt.getLastInterruptTime;

  function setVoiceStatus(text: string, tone: "ready" | "loading" | "error" = "ready"): void {
    const hint = document.getElementById("audio-hint");
    if (!hint) return;
    hint.textContent = text;
    hint.dataset.tone = tone;
  }

  /**
   * Request transcription model initialization (lazy, non-blocking).
   * Uses requestIdleCallback for non-blocking startup when available.
   */
  function requestTranscriptionInit(reason: string): void {
    if (transcription.isReady()) return;
    if (transcriptionInitRequested) return;
    transcriptionInitRequested = true;

    const start = () => {
      console.log(`[voice-preload] Initializing transcription model (${reason})...`);
      logInfo(`🎙️ Initializing transcription model (${reason})...`);
      setVoiceStatus("Loading voice…", "loading");
      transcriptionInitPromise = transcription
        .initialize(electronRpc.rpc as any)
        .then(() => {
          console.log("[voice-preload] Transcription service ready");
          logInfo("✅ Transcription service ready");
          setVoiceStatus("Listening ready", "ready");
        })
        .catch((error) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error("[voice-preload] Failed to initialize transcription:", errorMessage);
          logError("❌ Failed to initialize transcription:", errorMessage);
          logError("Error details:", error);

          // Show a more user-friendly error message
          let userMessage = `Transcription unavailable: ${errorMessage}`;
          if (errorMessage.includes("Network error") || errorMessage.includes("Failed to fetch")) {
            userMessage = "Cannot download transcription model. Check your internet connection.";
          }

          setVoiceStatus("Voice unavailable", "error");
          toast.show(userMessage, 8000);
        });
    };

    // Try to start in idle time, but guarantee it starts soon via timeout.
    const w = window as unknown as {
      requestIdleCallback?: (cb: (deadline: IdleDeadline) => void, opts?: { timeout: number }) => number;
    };
    const ric = w.requestIdleCallback;

    if (typeof ric === "function") {
      ric(
        (deadline) => {
          if (deadline.timeRemaining() > 8) start();
          else ric(() => start(), { timeout: 2000 });
        },
        { timeout: 2000 }
      );
    } else {
      start();
    }
  }

  // Follow-up mode state: after Ari responds, treat speech as follow-ups for 10s
  const FOLLOWUP_TIMEOUT_MS = 10000; // 10 seconds of silence to exit follow-up mode
  let isFollowupMode: boolean = false;
  let followupTimeoutId: number | null = null;
  let isUserSpeaking: boolean = false;
  let currentSpeechStartedInFollowupMode: boolean = false;

  let lastTranscriptionTime: number = 0;
  const TRANSCRIPTION_DEBOUNCE_MS = 500; // 500ms debounce (reduced since we use rolling buffer)

  // ============================================================================
  // Rolling Audio Buffer - NEVER drops user speech!
  // Instead of a queue that can overflow, we use a continuous buffer that grows
  // and only shrinks after successful transcription processing.
  // ============================================================================
  interface AudioBufferState {
    buffer: Float32Array; // Growing continuous audio buffer
    utteranceMarkers: number[]; // Positions where speech pauses occurred
    utteranceFollowupFlags: boolean[]; // Whether each utterance started during follow-up mode
    lastProcessedIndex: number; // How far we've transcribed
    totalSamplesAppended: number; // Track total for logging
  }

  const audioState: AudioBufferState = {
    buffer: new Float32Array(0),
    utteranceMarkers: [],
    utteranceFollowupFlags: [],
    lastProcessedIndex: 0,
    totalSamplesAppended: 0,
  };

  let isProcessingBuffer: boolean = false;

  /**
   * Helper to concatenate Float32Arrays
   */
  function concatenateBuffers(a: Float32Array, b: Float32Array): Float32Array {
    const result = new Float32Array(a.length + b.length);
    result.set(a);
    result.set(b, a.length);
    return result;
  }

  /**
   * Reconcile microphone indicator from current pipeline state.
   * Priority: off > transcribing > recording > followup > listening.
   */
  function reconcileMicrophoneIndicator(forcedState?: IndicatorState): void {
    if (forcedState) {
      micManager.setIndicatorState(forcedState);
      return;
    }

    if (!micManager.isEnabled() || micManager.getState() !== "listening") {
      micManager.setIndicatorState("off");
      return;
    }

    if (isTranscribing) {
      micManager.setIndicatorState("transcribing");
      return;
    }

    if (isUserSpeaking) {
      micManager.setIndicatorState("recording");
      return;
    }

    micManager.setIndicatorState(isFollowupMode ? "followup" : "listening");
  }

  /**
   * Activate follow-up mode (called after AI response)
   */
  function activateFollowupMode(): void {
    logDebug("💬 Activating follow-up mode");
    isFollowupMode = true;
    resetFollowupTimeout();
    reconcileMicrophoneIndicator();
  }

  /**
   * Deactivate follow-up mode (called after timeout)
   */
  function deactivateFollowupMode(): void {
    if (isFollowupMode) {
      logDebug("💬 Deactivating follow-up mode");
      isFollowupMode = false;
      if (followupTimeoutId !== null) {
        clearTimeout(followupTimeoutId);
        followupTimeoutId = null;
      }
      if (!isProcessingAI.current && micManager.isListening()) {
        reconcileMicrophoneIndicator();
      }
    }
  }

  /**
   * Reset the follow-up timeout (called when speech is detected)
   */
  function resetFollowupTimeout(): void {
    if (followupTimeoutId !== null) {
      clearTimeout(followupTimeoutId);
    }
    followupTimeoutId = window.setTimeout(() => {
      // If the user is currently speaking, never let follow-up mode expire mid-utterance.
      // We'll start the silence countdown again when speech ends.
      if (isUserSpeaking) {
        resetFollowupTimeout();
        return;
      }
      deactivateFollowupMode();
    }, FOLLOWUP_TIMEOUT_MS);
  }

  /**
   * Process a single transcription segment
   * Returns the transcribed text or null if failed/empty
   */
  async function processTranscriptionSegment(audioBuffer: Float32Array): Promise<string | null> {
    if (!transcription.isReady()) {
      logDebug("⏭️ Transcription not ready, skipping segment");
      return null;
    }

    try {
      const text = await transcription.transcribe(audioBuffer);
      logInfo(`🎙️ Microphone STT result (${audioBuffer.length} samples): "${text.substring(0, 160)}"`);

      if (!text || text.length === 0) {
        logDebug("⏭️ Empty transcription result");
        return null;
      }

      return text;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logError("❌ Transcription error:", errorMessage);
      toast.show(`Transcription error: ${errorMessage}`, 5000);
      return null;
    }
  }

  /**
   * Handle transcribed text - categorize and process
   */
  async function handleTranscribedText(
    text: string,
    options?: { forceFollowup?: boolean }
  ): Promise<void> {
    // Notify backend of voice activity (for routine reminders)
    electronRpc.rpc.send.voiceActivity({});

    // If the audio we captured began in follow-up mode, treat it as follow-up even if
    // the follow-up timer expired before transcription finished.
    const effectiveFollowupMode = Boolean(options?.forceFollowup) || isFollowupMode;

    if (shouldDropAsVoiceNoise(text, { isFollowupMode: effectiveFollowupMode })) {
      logDebug(`⏭️ Ignored voice noise before JSON AI routing: "${text}"`);
      return;
    }

    const microphoneSendToAi = await refreshMicrophoneSendToAi();

    try {
      await electronRpc.rpc.request.logAudioTranscript({
        source: "microphone",
        content: text,
        routedToAi: microphoneSendToAi,
        sampleRate: 16000,
        model: "parakeet.js",
        captureBackend: "getUserMedia",
        metadata: {
          forceFollowup: Boolean(options?.forceFollowup),
          effectiveFollowupMode,
        },
      });
    } catch (error) {
      logWarn("Failed to save microphone transcript:", error);
    }

    if (!microphoneSendToAi) {
      logDebug(`📝 Voice input transcribed only, not routed to Ari: "${text}"`);
      return;
    }

    logDebug(`🎯 Voice input routed JSON-only to Ari: "${text}"`);
    enqueueAriDecidesCandidate(text);
  }

  /**
   * Process the rolling audio buffer - handles all accumulated audio
   * This NEVER drops speech - audio accumulates and is processed in order
   */
  async function processAudioBuffer(): Promise<void> {
    // Prevent concurrent processing
    if (isProcessingBuffer) {
      logDebug("📥 Buffer processor already running");
      return;
    }

    // Nothing to process
    if (audioState.utteranceMarkers.length === 0) {
      logDebug("📥 No utterance markers to process");
      return;
    }

    isProcessingBuffer = true;
    isTranscribing = true;
    reconcileMicrophoneIndicator();

    const markersToProcess = audioState.utteranceMarkers.length;
    const endIndex = audioState.utteranceMarkers[audioState.utteranceMarkers.length - 1];
    const audioToProcess = audioState.buffer.slice(audioState.lastProcessedIndex, endIndex);
    const durationSecs = (audioToProcess.length / 16000).toFixed(2);

    logDebug(`🎙️ Processing audio buffer (${audioToProcess.length} samples, ~${durationSecs}s, ${markersToProcess} utterances)`);

    try {
      const text = await processTranscriptionSegment(audioToProcess);

      if (text) {
        logDebug(`✅ Transcription: "${text}"`);

        const followupForThisBatch = audioState.utteranceFollowupFlags
          .slice(0, markersToProcess)
          .some(Boolean);

        // ALWAYS call handleTranscribedText - it checks for interrupts
        // If AI is processing and it's not an interrupt, handleTranscribedText
        // will handle it appropriately (ignore or inject context)
        await handleTranscribedText(text, { forceFollowup: followupForThisBatch });
      }

      // Successfully processed - trim the buffer to free memory
      // Keep only audio after the last processed marker
      const processedSamples = audioState.buffer.length;
      audioState.buffer = audioState.buffer.slice(endIndex);
      audioState.lastProcessedIndex = 0;
      audioState.utteranceMarkers = audioState.utteranceMarkers
        .filter((m) => m > endIndex)
        .map((m) => m - endIndex);
      audioState.utteranceFollowupFlags = audioState.utteranceFollowupFlags.slice(markersToProcess);

      logDebug(`📊 Trimmed buffer from ${processedSamples} to ${audioState.buffer.length} samples`);
    } catch (error) {
      logError("❌ Error processing audio buffer:", error);
      // Don't trim on error - we'll retry with the same audio
    }

    isTranscribing = false;
    isProcessingBuffer = false;

    // Check if more audio arrived while we were processing
    if (audioState.utteranceMarkers.length > 0) {
      logDebug(`📥 More utterances arrived (${audioState.utteranceMarkers.length}), continuing...`);
      void processAudioBuffer();
    } else {
      // Update indicator based on current state
      if (micManager.isListening()) {
        reconcileMicrophoneIndicator();
      }
    }
  }

  /**
   * Restart microphone listening after AI processing completes
   */
  function restartMicrophoneListening(): void {
    if (!micManager.isEnabled()) {
      logDebug("🎤 Mic is disabled by user, skipping restart");
      reconcileMicrophoneIndicator("off");
      return;
    }

    // Use manager to check if we can start
    if (!isProcessingAI.current && micManager.getState() === "stopped") {
      logDebug("🎤 Restarting microphone listening...");
      void micManager
        .start()
        .then(() => {
          // Mic manager sets "listening" on start; immediately re-derive so
          // follow-up mode keeps the yellow indicator for the full window.
          reconcileMicrophoneIndicator();
        })
        .catch((error) => {
          logError("Failed to restart microphone:", error);
          reconcileMicrophoneIndicator("off");
        });
      return;
    }

    // If already listening, still re-derive to preserve follow-up color.
    if (!isProcessingAI.current && micManager.isListening()) {
      reconcileMicrophoneIndicator();
    }
  }

  // Wire up forward references for interrupt handler
  activateFollowupModeInternal = activateFollowupMode;
  restartMicrophoneListeningInternal = restartMicrophoneListening;

  /**
   * Toggle microphone enabled state
   */
  async function toggleMicrophone(): Promise<void> {
    await micManager.toggle();

    if (micManager.isEnabled()) {
      // Re-initialize transcription if not ready
      if (!transcription.isReady()) {
        logInfo("🎙️ User enabled mic, ensuring transcription is loading...");
      }
    } else {
      stopBargeInTracking();
    }
  }

  /**
   * Setup microphone event listeners
   */
  function setupMicrophoneHandlers(): void {
    // Handle microphone events
    micManager.onSpeechStart(() => {
      logDebug("🎤 Speech started");

      // Track follow-up mode for this utterance
      currentSpeechStartedInFollowupMode = isFollowupMode;
      isUserSpeaking = true;

      // Clear follow-up timeout on speech start (don't reset - we'll restart after speech ends)
      // This prevents follow-up mode from expiring mid-utterance
      if (followupTimeoutId !== null) {
        clearTimeout(followupTimeoutId);
        followupTimeoutId = null;
      }

      reconcileMicrophoneIndicator();

      // Voice-based barge-in: any user speech while Ari is talking/processing can interrupt her
      startBargeInTracking();

      // Stop reminder flashing if active
      stopFlashing();
    });

    micManager.onSpeechEnd(async (audioBuffer: Float32Array) => {
      const durationSecs = (audioBuffer.length / 16000).toFixed(2);
      logDebug(`🎤 Speech ended, audio buffer: ${audioBuffer.length} samples (${durationSecs}s)`);

      stopBargeInTracking();
      isUserSpeaking = false;

      // Mark whether this utterance began during follow-up mode, so classification stays correct
      // even if the follow-up timer expires before transcription finishes.
      audioState.utteranceFollowupFlags.push(currentSpeechStartedInFollowupMode);
      currentSpeechStartedInFollowupMode = false;

      // Restart follow-up timeout after speech ends (N seconds of silence to exit follow-up mode)
      if (isFollowupMode) {
        resetFollowupTimeout();
      }

      reconcileMicrophoneIndicator();

      // Skip if buffer is empty
      if (audioBuffer.length === 0) {
        logDebug("🎤 Empty audio buffer, skipping");
        return;
      }

      // Check if transcription is ready - if not, kick off initialization
      if (!transcription.isReady()) {
        logDebug("⏭️ Transcription not ready yet (model still loading)");
        // Kick off initialization on first actual user speech so it doesn't "take forever".
        requestTranscriptionInit("first user speech");
        setVoiceStatus("Voice loading", "loading");
        reconcileMicrophoneIndicator();
        return;
      }

      // Append audio to rolling buffer
      audioState.buffer = concatenateBuffers(audioState.buffer, audioBuffer);
      audioState.totalSamplesAppended += audioBuffer.length;

      const now = Date.now();
      const transcriptDelay = now - lastTranscriptionTime;
      const lastInterruptTime = getLastInterruptTime();

      // Bypass debounce if we just interrupted (so the user can speak immediately after interrupting)
      if (transcriptDelay < TRANSCRIPTION_DEBOUNCE_MS && now - lastInterruptTime >= TRANSCRIPTION_DEBOUNCE_MS) {
        logDebug(`🎤 Transcription debounce: ${transcriptDelay}ms (skipping)`);
        return;
      }

      lastTranscriptionTime = now;
      audioState.utteranceMarkers.push(audioState.buffer.length);

      const bufferDurationSecs = (audioState.buffer.length / 16000).toFixed(2);
      logDebug(`📥 Appended ${audioBuffer.length} samples to buffer (total: ${audioState.buffer.length}, ~${bufferDurationSecs}s, ${audioState.utteranceMarkers.length} markers)`);

      // Update indicator to show we're capturing
      if (!isTranscribing) {
        reconcileMicrophoneIndicator();
      }

      // Start processing in the background
      void processAudioBuffer();
    });

    micManager.onError((error: Error) => {
      logError("🎤 Microphone error:", error.message);
      toast.show(`Microphone error: ${error.message}`, 5000);
      reconcileMicrophoneIndicator("off");
    });
  }

  /**
   * Initialize microphone and transcription services.
   * This should be called during app startup.
   */
  async function initialize(): Promise<void> {
    try {
      logInfo("🎤 Initializing microphone and transcription services...");

      // Set up microphone callbacks FIRST (before starting microphone)
      setupMicrophoneHandlers();

      // Eagerly load settings/model at app startup so voice routing is ready.
      void refreshMicrophoneSendToAi();

      // Eagerly load the listening/transcription model at app startup so the
      // first real utterance does not pay the Parakeet model download/load cost.
      requestTranscriptionInit("app startup");

      reconcileMicrophoneIndicator(micManager.isEnabled() ? "off" : "off");
      logInfo("🎤 Voice input is armed but not auto-started; click the microphone to enable listening");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logError("❌ Failed to initialize microphone services:", errorMessage);
      // Don't block app startup if microphone fails
      reconcileMicrophoneIndicator("off");
      toast.show(`Microphone unavailable: ${errorMessage}`, 5000);
    }
  }

  return {
    // Lifecycle
    initialize,
    setupMicrophoneHandlers,

    // Mic control
    toggleMicrophone,
    restartMicrophoneListening,
    updateMicrophoneIndicator: reconcileMicrophoneIndicator,
    reconcileMicrophoneIndicator,
    stopMicrophoneListening: () => {
      micManager.stop();
      reconcileMicrophoneIndicator("off");
    },

    // Follow-up mode
    activateFollowupMode,
    deactivateFollowupMode,
    getIsFollowupMode: () => isFollowupMode,

    // Interrupt
    interruptAndResetUI,
    getLastInterruptTime,

    // Barge-in settings
    setBargeInEnabled: bargeIn.setBargeInEnabled,
    setBargeInThreshold: bargeIn.setBargeInThreshold,
    getBargeInEnabled: bargeIn.getBargeInEnabled,
    getBargeInThresholdMs: bargeIn.getBargeInThresholdMs,

    // Transcription
    requestTranscriptionInit,
    processAudioBuffer,
    handleTranscribedText,

    // State queries
    isMicEnabled: () => micManager.isEnabled(),
    isTranscriptionReady: () => transcription.isReady(),
  };
}
