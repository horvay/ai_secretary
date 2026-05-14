/**
 * AI Secretary Avatar - Frontend Entry Point
 * Visual avatar interface with chat, TTS, and microphone input
 */

import { defineRPC, ElectronView } from "./electron-rpc";
import { type AISecretaryRPC } from "../shared/rpc";
import { createAvatar, setSpriteRPC, type AvatarInstance, type AvatarState } from "./components/Avatar";
import { createChatBubble, type ChatBubbleInstance } from "./components/ChatBubble";
import { createInputModal, type InputModalInstance } from "./components/InputModal";
import { createProgressModal, type ProgressModalInstance } from "./components/ProgressModal";
import { createAgentActivityModal, type AgentActivityModalInstance } from "./components/AgentActivityModal";
import { createUnifiedSettingsModal, type UnifiedSettingsModalInstance, type MemoryStats } from "./components/UnifiedSettingsModal";
import { createToast, type ToastInstance } from "./components/Toast";
import { createMessageHistoryModal, type MessageHistoryModalInstance } from "./components/MessageHistoryModal";
import { createMicrophoneManager, type MicrophoneManager, type IndicatorState } from "./services/MicrophoneManager";
import { createTranscription, type TranscriptionInstance } from "./services/transcription";
import { createVoiceInputPipeline } from "./services/VoiceInputPipeline";
import { stopAudio, playAudio, setAvatarRef, closeAudioContext, setMuted, getMuted, setVolume, getVolume, initAudioContextOnUserGesture, clearPlaybackSuppression, suppressPlayback } from "./services/audioPlayer";
import { createMessageHandlers, createRequestHandlers } from "./rpc/handlers";
import { logDebug, logInfo, logWarn, logError } from "./utils/logger";
import { createLifecycleManager } from "./utils/lifecycle";
import type { ElectronRpcInstance, ElectronRpcRPC } from "./types/app-rpc";
import { setupHotkeys } from "./services/hotkeys";
import { registerSettingsCallbacks } from "./services/settingsCallbacks";

interface AppState {
  avatar: AvatarInstance;
  chatBubble: ChatBubbleInstance;
  toast: ToastInstance;
  messageHistoryModal: MessageHistoryModalInstance;
  inputModal: InputModalInstance;
  unifiedSettingsModal: UnifiedSettingsModalInstance;
  progressModal: ProgressModalInstance;
  electronRpc: ElectronRpcInstance;
}

/**
 * Initialize the AI Secretary App
 */
function initializeApp(): AppState {
  logInfo("🤖 AI Secretary Avatar initializing...");

  // Register user-gesture listeners ASAP so the AudioContext gets resumed on the
  // very first click/keypress. This prevents the "AudioContext was not allowed to
  // start" error that blocks all TTS audio playback.
  initAudioContextOnUserGesture();

  // Initialize components (avatar is created after RPC is set up)
  const chatBubble = createChatBubble();
  const toast = createToast();
  const inputModal = createInputModal();
  const progressModal = createProgressModal();
  const agentActivityModal = createAgentActivityModal();

  // Message history modal will be initialized after electronRpc is ready
  let messageHistoryModal: MessageHistoryModalInstance;

  // Unified settings modal (includes both settings and debug tabs)
  const unifiedSettingsModal = createUnifiedSettingsModal();

  // ============================================================================
  // Lifecycle Manager - Tracks all resources for cleanup
  // ============================================================================
  const lifecycle = createLifecycleManager();

  // ============================================================================
  // Microphone Manager - Unified microphone capture, VAD, state machine, UI
  // ============================================================================
  const micManager = createMicrophoneManager({
    speechThreshold: 0.005, // Lower threshold for better sensitivity
    silenceThreshold: 0.002,
    silenceDuration: 800, // 0.8 seconds - faster response for interrupts
    sampleRate: 16000,
    indicatorElementId: "microphone-indicator",
  });

  // State references for RPC handlers (using object refs for mutability)
  let responseHideTimeout: { current: number | null } = { current: null };
  let errorHideTimeout: { current: number | null } = { current: null };
  let previousAvatarState: { current: AvatarState } = { current: "idle" };
  let isProcessingAI: { current: boolean } = { current: false };

  // Avatar instance (created after RPC is set up)
  let avatar: AvatarInstance;

  // Transcription service
  const transcription = createTranscription();

  // State for microphone/transcription
  let isTranscribing: boolean = false;

  // Barge-in detection state
  let bargeInSpeechStartTime: number | null = null;
  let bargeInCheckInterval: ReturnType<typeof setInterval> | null = null;
  let bargeInEnabled: boolean = true; // Can be toggled via settings
  // For "any voice" barge-in, keep this low so speaking up interrupts quickly.
  // Higher mic thresholds during TTS (see src/avatar/rpc/handlers.ts) are the main defense against false triggers.
  let bargeInThresholdMs: number = 200; // 0.2 seconds default
  // Used to bypass transcription debounce right after an interrupt, so the user can speak immediately.
  let lastInterruptTime: number = 0;
  // Prevent overlapping interrupts (can happen if multiple triggers fire close together).
  let interruptInFlight: Promise<void> | null = null;

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
      stopAudio();

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

      // Since mic was stopped during TTS, restart it now so user can speak immediately
      restartMicrophoneListening();
    })()
      .finally(() => {
        interruptInFlight = null;
      });

    return interruptInFlight;
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

  // Follow-up mode state: after Ari responds, treat speech as follow-ups for 30s
  const FOLLOWUP_TIMEOUT_MS = 10000; // 10 seconds of silence to exit follow-up mode
  let isFollowupMode: boolean = false;
  let followupTimeoutId: number | null = null;
  let isUserSpeaking: boolean = false;
  let currentSpeechStartedInFollowupMode: boolean = false;
  let isReminderFlashing: boolean = false;

  /**
   * Start the reminder flashing effect
   */
  function startFlashing(): void {
    if (isReminderFlashing) return;
    const appEl = document.getElementById("app");
    if (appEl) {
      appEl.classList.add("flashing");
      isReminderFlashing = true;
      logDebug("✨ Started reminder flashing");
    }
  }

  /**
   * Stop the reminder flashing effect
   */
  function stopFlashing(): void {
    if (!isReminderFlashing) return;
    const appEl = document.getElementById("app");
    if (appEl) {
      appEl.classList.remove("flashing");
      isReminderFlashing = false;
      logDebug("✨ Stopped reminder flashing");
    }
  }

  // Register cleanup function for the lifecycle manager
  lifecycle.onCleanup(async () => {
    // Stop microphone via manager
    micManager.destroy();

    // Stop barge-in tracking
    stopBargeInTracking();

    // Clear follow-up timeout
    if (followupTimeoutId !== null) {
      clearTimeout(followupTimeoutId);
      followupTimeoutId = null;
    }

    // Clear response hide timeout
    if (responseHideTimeout.current !== null) {
      clearTimeout(responseHideTimeout.current);
      responseHideTimeout.current = null;
    }

    // Clear error hide timeout
    if (errorHideTimeout.current !== null) {
      clearTimeout(errorHideTimeout.current);
      errorHideTimeout.current = null;
    }

    // Close audio context
    await closeAudioContext();

    logInfo("🧹 Avatar cleanup complete");
  });

  /**
   * Activate follow-up mode after Ari responds
   */
  function activateFollowupMode(): void {
    logDebug("💬 Activating follow-up mode");
    isFollowupMode = true;
    resetFollowupTimeout();
    micManager.setIndicatorState("followup");
  }

  /**
   * Deactivate follow-up mode
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
        micManager.setIndicatorState("listening");
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

  // ElectronRpc instance (will be set up with RPC)
  // NOTE: ElectronRpc's runtime type doesn't perfectly match our local typing in all environments,
  // so keep this flexible to avoid cascading type errors.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let electronRpc: any;

  /**
   * Ask question to AI
   */
  async function askQuestion(
    question: string,
    includeScreenshot: boolean = false,
    activeWindowOnly: boolean = false,
    options?: {
      source?: "text" | "voice" | "routine" | "reminder" | "system";
      showUserQuestion?: boolean;
      historyLabel?: string;
      voiceMode?: "normal" | "ari-decides";
    },
  ): Promise<{ response: string; delivered: boolean; visibleText: boolean; audible: boolean }> {
    try {
      const avatarStateBeforeSubmit = avatar.getState();
      const isAriDecidesCandidate = options?.voiceMode === "ari-decides";
      const shouldPreemptCurrentTurn = !isAriDecidesCandidate && (
        avatarStateBeforeSubmit === "talking" ||
        avatarStateBeforeSubmit === "processing" ||
        isProcessingAI.current
      );

      if (shouldPreemptCurrentTurn) {
        logInfo(
          `🛑 Preempting current turn before new typed question (avatarState=${avatarStateBeforeSubmit}, processing=${isProcessingAI.current})`
        );

        // Block any stale chunks while we hand off to the new request.
        suppressPlayback();
        stopAudio();

        try {
          await electronRpc.rpc.request.interruptResponse({});
        } catch (err) {
          logWarn("Failed to preempt current turn before new question:", err);
        }
      }

      // Allow playback for the new response now that preemption is done.
      clearPlaybackSuppression();

      // Stop any current audio
      stopAudio();

      // Deactivate follow-up mode when starting new processing
      deactivateFollowupMode();

      // Mark that we're processing AI
      isProcessingAI.current = true;

      // Note: Microphone will be stopped by setState handler when avatar goes to "talking"
      // and restarted when avatar goes back to "idle"

      // Set avatar to processing
      avatar.setState("processing");
      chatBubble.hide();

      // Clear any pending error hide timeout
      if (errorHideTimeout.current) {
        clearTimeout(errorHideTimeout.current);
        errorHideTimeout.current = null;
      }

      // Call RPC
      const result = await electronRpc.rpc.request.askQuestion({
        question,
        includeScreenshot,
        activeWindowOnly,
        source: options?.source,
        showUserQuestion: options?.showUserQuestion,
        historyLabel: options?.historyLabel,
        voiceMode: options?.voiceMode,
      });

      // Response is handled via RPC messages (setState, showResponse, playAudio)
      logInfo("Question answered:", result.response);
      return {
        response: result.response,
        delivered: result.delivered,
        visibleText: result.visibleText,
        audible: result.audible,
      };
    } catch (error) {
      logError("Failed to ask question:", error);
      avatar.setState("idle");
      stopAudio();

      const errorMessage = error instanceof Error ? error.message : "Failed to get response";
      toast.show(errorMessage, 5000);
      throw error;
    }
  }

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
   * Restart microphone listening after AI processing completes
   */
  function restartMicrophoneListening(): void {
    if (!micManager.isEnabled()) {
      logDebug("🎤 Mic is disabled by user, skipping restart");
      micManager.setIndicatorState("off");
      return;
    }

    // Use manager to check if we can start
    if (!isProcessingAI.current && micManager.getState() === "stopped") {
      logDebug("🎤 Restarting microphone listening...");
      void micManager.start().catch((error) => {
        logError("Failed to restart microphone:", error);
        micManager.setIndicatorState("off");
      });
    }
  }

  /**
   * Trigger profile reconciliation (summarize today and update profile)
   */
  async function triggerReconcileProfile(): Promise<void> {
    try {
      logInfo("🧠 Triggering reconcile profile...");
      toast.show("Reconciling profile...");
      const result = await electronRpc.rpc.request.triggerDailySummary({});
      if (result?.profileUpdates) {
        toast.show("Profile updated with new facts!");
      } else if (result) {
        toast.show(`Summary generated: ${result.summary}`);
      } else {
        toast.show("No new facts to add to profile.");
      }
    } catch (error) {
      logError("Failed to reconcile profile:", error);
      toast.show("Failed to reconcile profile", 5000);
    }
  }

  /**
   * Open unified settings modal and load current settings.
   */
  async function openSettings(tab: "settings" | "debug" = "settings"): Promise<void> {
    // Fetch reminder interval
    try {
      const { intervalMinutes } = await electronRpc.rpc.request.getReminderInterval({});
      unifiedSettingsModal.updateReminderInterval(intervalMinutes);
    } catch (error) {
      logError("Failed to get reminder interval:", error);
    }

    // AI overrides toggle
    try {
      const { allowAi } = await electronRpc.rpc.request.getAvatarOverrideAllowAi({});
      unifiedSettingsModal.updateAvatarOverrideAllowAi(allowAi);
    } catch (error) {
      logError("Failed to get AI overrides toggle:", error);
    }

    // Thinking level
    try {
      const { variant } = await electronRpc.rpc.request.agentGetThinkingLevel({});
      unifiedSettingsModal.updateThinkingLevel(variant);
    } catch (error) {
      logError("Failed to get agent thinking level:", error);
    }

    try {
      const settings = await electronRpc.rpc.request.getLocalModelSettings({});
      unifiedSettingsModal.updateLocalModelSettings(settings);
    } catch (error) {
      logError("Failed to get local model settings:", error);
    }

    // Update barge-in settings display
    unifiedSettingsModal.updateBargeInSettings({
      enabled: tempPipelineRef.current?.getBargeInEnabled() ?? true,
      thresholdSeconds: (tempPipelineRef.current?.getBargeInThresholdMs() ?? 200) / 1000,
    });

    // Update mute state display
    unifiedSettingsModal.updateMuteState(getMuted());

    await unifiedSettingsModal.show(tab);
  }

  /**
   * Setup click handlers
   */
  function setupClickHandlers(): void {
    // Click on avatar to open input modal
    const avatarEl = document.getElementById("avatar-canvas");
    if (avatarEl) {
      // Left click to open input modal
      avatarEl.addEventListener("click", (e) => {
        e.stopPropagation();
        inputModal.show();
      });

      // Right click to open settings
      avatarEl.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openSettings();
      });
    }

    // Click on microphone to toggle
    const micIndicator = document.getElementById("microphone-indicator");
    if (micIndicator) {
      micIndicator.addEventListener("click", (e) => {
        e.stopPropagation();
        void toggleMicrophone();
      });
    }

    // Click outside modal to close
    const modalEl = document.getElementById("input-modal");
    if (modalEl) {
      modalEl.addEventListener("click", (e) => {
        if (e.target === modalEl) {
          inputModal.hide();
        }
      });
    }
  }

  // Set up RPC with handlers from extracted module
  // Note: We need to create temporary references for components initialized after RPC
  const tempAvatarRef = { current: null as AvatarInstance | null };
  const tempMessageHistoryModalRef = { current: null as MessageHistoryModalInstance | null };
  const tempRpcRef = { current: null as ElectronRpcRPC | null };
  const tempElectronRpcRef = { current: null as ElectronRpcInstance | null };

  // Temporary reference for voice input pipeline (created after electronRpc)
  const tempPipelineRef = {
    current: null as ReturnType<typeof createVoiceInputPipeline> | null,
  };

  // Screenshot function that captures the current window
  async function takeScreenshotToFile(filePath: string): Promise<void> {
    try {
      // Use html2canvas to capture the document
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(document.body, {
        backgroundColor: null,
        scale: 1,
        logging: false,
        useCORS: true,
      });

      // Convert to base64 PNG
      const dataUrl = canvas.toDataURL("image/png");
      const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");

      // Send to backend to save
      if (tempRpcRef.current) {
        const result = await tempRpcRef.current.request.saveScreenshotToFile({
          imageData: base64Data,
          filePath: filePath,
        });
        logInfo(`📸 Screenshot saved: ${result.path}`);
      }
    } catch (error) {
      logError("Failed to take screenshot:", error);
    }
  }

  const messageHandlers = createMessageHandlers({
    avatar: {
      setState: (state: AvatarState) => tempAvatarRef.current?.setState(state),
      setStatus: (status: string) => tempAvatarRef.current?.setStatus(status),
      setOverrideStateKey: async (key: string) => tempAvatarRef.current?.setOverrideStateKey(key),
      getState: () => tempAvatarRef.current?.getState() ?? "idle",
      getStatus: () => tempAvatarRef.current?.getStatus() ?? "normal",
      destroy: () => tempAvatarRef.current?.destroy(),
      isLoaded: () => tempAvatarRef.current?.isLoaded() ?? false,
      reloadSprites: async () => tempAvatarRef.current?.reloadSprites(),
    } as AvatarInstance,
    chatBubble,
    toast,
    progressModal,
    agentActivityModal,
    messageHistoryModal: {
      show: async () => tempMessageHistoryModalRef.current?.show(),
      hide: () => tempMessageHistoryModalRef.current?.hide(),
      isVisible: () => tempMessageHistoryModalRef.current?.isVisible() ?? false,
    } as MessageHistoryModalInstance,
    transcription,
    askQuestion,
    triggerReconcileProfile,
    takeScreenshot: takeScreenshotToFile,
    openSettings,
    responseHideTimeout,
    previousAvatarState,
    isProcessingAI,
    restartMicrophoneListening: () => tempPipelineRef.current?.restartMicrophoneListening(),
    stopMicrophoneListening: () => tempPipelineRef.current?.stopMicrophoneListening(),
    activateFollowupMode: () => tempPipelineRef.current?.activateFollowupMode(),
    electronRpc: tempElectronRpcRef, // Passed as reference, set after electronRpc is created
    startFlashing,
  });

  const rpc = defineRPC<AISecretaryRPC>({
    maxRequestTime: 300000, // 5 minutes - AI agentic workflows can take a while
    handlers: {
      requests: createRequestHandlers(),
      messages: messageHandlers,
    },
  });
  tempRpcRef.current = rpc;

  // Create ElectronView instance
  electronRpc = new ElectronView({ rpc });
  tempElectronRpcRef.current = electronRpc; // Make available to message handlers

  // Notify bun that the webview bridge is ready
  void rpc.request.webviewReady({}).catch((error) => {
    logWarn("Failed to send webviewReady signal:", error);
  });

  // Initialize message history modal (needs electronRpc for RPC)
  messageHistoryModal = createMessageHistoryModal("message-history-modal", electronRpc.rpc!);
  tempMessageHistoryModalRef.current = messageHistoryModal;

  // Set up sprite RPC for Avatar component (animated WebP)
  setSpriteRPC({
    loadAnimatedSprite: (params) => electronRpc.rpc.request.loadAnimatedSprite(params),
    loadAnimatedSpritesForType: (params) => electronRpc.rpc.request.loadAnimatedSpritesForType(params),
    loadOverrideSpriteSheet: (params) => electronRpc.rpc.request.loadOverrideSpriteSheet(params),
    getSpriteInfo: () => electronRpc.rpc.request.getSpriteInfo({}),
  });

  // Now create the avatar (after RPC is set up)
  avatar = createAvatar();
  tempAvatarRef.current = avatar;

  // Set avatar reference for audio player
  setAvatarRef(avatar);

  // ============================================================================
  // Voice Input Pipeline - Consolidates mic, transcription, barge-in, interrupt
  // ============================================================================
  const voiceInputPipeline = createVoiceInputPipeline({
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
  });

  // Wire up pipeline reference for message handlers
  tempPipelineRef.current = voiceInputPipeline;

  // Wire up pipeline methods to replace local duplicates
  // These delegations ensure all existing references continue to work
  const pipelineInterruptAndResetUI = voiceInputPipeline.interruptAndResetUI;
  const pipelineActivateFollowupMode = voiceInputPipeline.activateFollowupMode;
  const pipelineDeactivateFollowupMode = voiceInputPipeline.deactivateFollowupMode;
  const pipelineRestartMicrophoneListening = voiceInputPipeline.restartMicrophoneListening;
  const pipelineSetBargeInEnabled = voiceInputPipeline.setBargeInEnabled;
  const pipelineSetBargeInThreshold = voiceInputPipeline.setBargeInThreshold;

  // Setup input modal callbacks
  inputModal.onSend((text, includeScreenshot, activeWindowOnly) => {
    askQuestion(text, includeScreenshot, activeWindowOnly);
  });

  // Setup skip button callback for chat bubble
  chatBubble.onSkip(() => {
    void pipelineInterruptAndResetUI("skip button");
  });

  inputModal.onCancel(() => {
    // Just hide, nothing else needed
  });

  const logInfoAny = (...args: unknown[]) => {
    const [message, ...rest] = args;
    logInfo(String(message ?? ""), ...rest);
  };
  const logErrorAny = (...args: unknown[]) => {
    const [message, ...rest] = args;
    logError(String(message ?? ""), ...rest);
  };

  // Setup unified settings modal callbacks
  registerSettingsCallbacks({
    unifiedSettingsModal,
    electronRpc,
    toast,
    avatar,
    setMuted,
    triggerReconcileProfile,
    setBargeInEnabled: pipelineSetBargeInEnabled,
    setBargeInThreshold: pipelineSetBargeInThreshold,
    logInfo: logInfoAny,
    logError: logErrorAny,
  });

  (globalThis as typeof globalThis & {
    __aiSecretaryTest?: {
      askQuestion: typeof askQuestion;
      openSettings: typeof openSettings;
      openModal: (tab?: "history" | "current-session" | "routines" | "lists" | "transcripts" | "tasks" | "reminders") => Promise<void>;
      screenshot: typeof takeScreenshotToFile;
      text: () => string;
      state: () => { avatarState: AvatarState; processing: boolean };
      setMicrophoneEnabled: (enabled: boolean) => Promise<boolean>;
    };
  }).__aiSecretaryTest = {
    askQuestion,
    openSettings,
    openModal: async (tab = "history") => {
      await messageHistoryModal.show();
      if (tab !== "history") {
        (document.querySelector(`[data-tab="${tab}"]`) as HTMLElement | null)?.click();
      }
    },
    screenshot: takeScreenshotToFile,
    text: () => document.body.innerText,
    state: () => ({ avatarState: avatar.getState(), processing: isProcessingAI.current }),
    setMicrophoneEnabled: async (enabled: boolean) => {
      if (micManager.isEnabled() !== enabled) {
        await toggleMicrophone();
      }
      return micManager.isEnabled();
    },
  };

  // Setup global hotkeys
  setupHotkeys({
    lifecycle,
    inputModal,
    unifiedSettingsModal,
    openSettings,
    avatar,
    interruptAndResetUI: pipelineInterruptAndResetUI,
    logInfo: logInfoAny,
  });

  // Setup click handlers
  setupClickHandlers();

  // Setup mousemove listener to stop flashing
  lifecycle.addEventListener(window, "mousemove", () => {
    if (isReminderFlashing) {
      stopFlashing();
    }
  });

  // Setup hamburger button for message history
  const hamburgerButton = document.getElementById("hamburger-button");
  if (hamburgerButton) {
    hamburgerButton.addEventListener("click", () => {
      messageHistoryModal.show();
    });
  }

  // Setup gear button for unified settings
  function setupGearButton(): void {
    const gearButton = document.createElement("div");
    gearButton.id = "debug-gear-btn";
    gearButton.className = "debug-gear-btn";
    gearButton.innerHTML = "⚙️";
    gearButton.title = "Settings";
    document.body.appendChild(gearButton);

    gearButton.addEventListener("click", () => {
      openSettings("settings");
    });
  }
  setupGearButton();

  type CompanionPlacementPayload = {
    placement: { monitorId: number | "primary"; corner: string };
    displays: Array<{ id: number; label: string; primary: boolean }>;
  };

  async function setupCompanionPlacementSettings(): Promise<void> {
    const monitorSelect = document.getElementById("settings-companion-monitor") as HTMLSelectElement | null;
    const cornerSelect = document.getElementById("settings-companion-corner") as HTMLSelectElement | null;
    if (!monitorSelect || !cornerSelect || !window.electronAPI) return;

    const refresh = async () => {
      const result = await window.electronAPI?.request("getCompanionPlacement", {}) as CompanionPlacementPayload | undefined;
      if (!result) return;
      monitorSelect.innerHTML = "";
      for (const display of result.displays) {
        const option = document.createElement("option");
        option.value = String(display.id);
        option.textContent = `${display.label}${display.primary ? " · primary" : ""}`;
        monitorSelect.appendChild(option);
      }
      monitorSelect.value = String(result.placement.monitorId === "primary" ? result.displays.find((display) => display.primary)?.id : result.placement.monitorId);
      cornerSelect.value = result.placement.corner;
    };

    const save = async () => {
      const monitorId = Number(monitorSelect.value);
      await window.electronAPI?.request("setCompanionPlacement", {
        monitorId: Number.isFinite(monitorId) ? monitorId : "primary",
        corner: cornerSelect.value,
      });
    };

    monitorSelect.addEventListener("change", () => void save());
    cornerSelect.addEventListener("change", () => void save());
    await refresh();
  }

  void setupCompanionPlacementSettings();

  function setupCompanionAutoCollapse(): void {
    if (!window.electronAPI) return;

    let hovered = false;
    let active = false;
    let expanded = true;
    let collapseTimer: number | null = null;
    let ignoreHoverUntil = 0;

    const sendExpanded = (nextExpanded: boolean) => {
      if (expanded === nextExpanded) return;
      expanded = nextExpanded;
      if (!nextExpanded) {
        ignoreHoverUntil = Date.now() + 850;
      }
      document.body.classList.toggle("companion-collapsed", !nextExpanded);
      void window.electronAPI?.request("setCompanionExpanded", { expanded: nextExpanded });
    };

    const schedule = () => {
      if (collapseTimer !== null) {
        clearTimeout(collapseTimer);
        collapseTimer = null;
      }

      if (hovered || active) {
        sendExpanded(true);
        return;
      }

      collapseTimer = window.setTimeout(() => {
        if (!hovered && !active) sendExpanded(false);
      }, 1400);
    };

    const markHovered = (nextHovered: boolean) => {
      if (nextHovered && !expanded && Date.now() < ignoreHoverUntil) return;
      hovered = nextHovered;
      schedule();
    };

    document.body.addEventListener("mouseenter", () => markHovered(true));
    document.body.addEventListener("mouseover", () => markHovered(true));
    document.body.addEventListener("mousemove", () => markHovered(true));
    document.body.addEventListener("mouseleave", () => markHovered(false));

    window.addEventListener("blur", () => {
      hovered = false;
      schedule();
    });

    const originalSetState = avatar.setState;
    avatar.setState = (state: AvatarState) => {
      originalSetState(state);
      active = state === "talking" || state === "processing";
      document.body.classList.toggle("companion-active", active);
      schedule();
    };

    active = avatar.getState() === "talking" || avatar.getState() === "processing";
    document.body.classList.toggle("companion-active", active);
    schedule();
  }

  setupCompanionAutoCollapse();

  // Setup mute button
  function setupMuteButton(): void {
    const muteButton = document.getElementById("mute-button");
    const muteIcon = muteButton?.querySelector(".mute-icon");
    const volumeSlider = document.getElementById("volume-slider") as HTMLInputElement | null;
    if (!muteButton || !muteIcon) return;
    const muteButtonEl = muteButton;
    const muteIconEl = muteIcon as HTMLElement;

    const VOLUME_STORAGE_KEY = "ari_volume";
    function loadStoredVolume(): number {
      try {
        const raw = localStorage.getItem(VOLUME_STORAGE_KEY);
        if (!raw) return 1.0;
        const parsed = parseFloat(raw);
        if (!Number.isFinite(parsed)) return 1.0;
        return Math.max(0.0, Math.min(1.0, parsed));
      } catch {
        return 1.0;
      }
    }

    function saveStoredVolume(v: number): void {
      try {
        localStorage.setItem(VOLUME_STORAGE_KEY, String(v));
      } catch {
        // ignore
      }
    }

    // Initialize volume from storage (or keep default)
    const initialVolume = loadStoredVolume();
    setVolume(initialVolume);
    if (volumeSlider) {
      volumeSlider.value = String(Math.round(getVolume() * 100));
      // Prevent slider interaction from toggling mute
      ["click", "mousedown", "pointerdown", "touchstart"].forEach((evt) => {
        volumeSlider.addEventListener(evt, (e) => e.stopPropagation(), { passive: true });
      });
      volumeSlider.addEventListener("input", (e) => {
        e.stopPropagation();
        const v = Math.max(0, Math.min(100, parseInt(volumeSlider.value || "100", 10))) / 100;
        setVolume(v);
        saveStoredVolume(v);
      });
    }

    // Update button appearance based on mute state
    function updateMuteButtonAppearance(muted: boolean): void {
      if (muted) {
        muteButtonEl.classList.add("muted");
        muteIconEl.textContent = "🔇";
        muteButtonEl.title = "Unmute Ari";
      } else {
        muteButtonEl.classList.remove("muted");
        muteIconEl.textContent = "🔊";
        muteButtonEl.title = "Mute Ari";
      }
    }

    // Initialize button state
    updateMuteButtonAppearance(getMuted());

    // Sync mute state from backend on startup
    electronRpc.rpc.request.getMuted({}).then(({ muted }) => {
      setMuted(muted);
      updateMuteButtonAppearance(muted);
      unifiedSettingsModal.updateMuteState(muted);
    }).catch(err => {
      logWarn("Failed to sync initial mute state from backend:", err);
    });

    // Handle click
    muteButtonEl.addEventListener("click", (e) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".volume-popover")) return;
      const newMutedState = !getMuted();
      setMuted(newMutedState);

      // Notify backend
      electronRpc.rpc.request.setMuted({ muted: newMutedState }).catch(err => {
        logError("Failed to notify backend of mute state:", err);
      });

      updateMuteButtonAppearance(newMutedState);
      // Sync with settings modal if it's open
      unifiedSettingsModal.updateMuteState(newMutedState);
    });
  }
  setupMuteButton();

  // Setup window focus/blur handlers for transparency - uses lifecycle manager
  function setupWindowFocusHandlers(): void {
    lifecycle.addEventListener(window, "focus", () => {
      logDebug("🎯 Window focused");
      document.body.classList.remove("window-blurred");
      // Notify Bun process
      electronRpc.rpc.send.windowFocus({});
    });

    lifecycle.addEventListener(window, "blur", () => {
      logDebug("👻 Window blurred");
      document.body.classList.add("window-blurred");
      // Hide input modal when window loses focus (but NOT settings modal -
      // native select dropdowns cause blur events when opened)
      if (inputModal.isVisible()) {
        inputModal.hide();
      }
      // Note: Don't hide unifiedSettingsModal on blur because native <select>
      // dropdowns trigger blur events when their popup opens
      // Notify Bun process
      electronRpc.rpc.send.windowBlur({});
    });
  }

  setupWindowFocusHandlers();

  // Register beforeunload to trigger lifecycle cleanup
  lifecycle.addEventListener(window, "beforeunload", () => {
    lifecycle.cleanup();
  });

  // Legacy microphone initialization path was removed.
  // VoiceInputPipeline is now the only owner of mic/transcription lifecycle.

  // Initialize voice input pipeline after a short delay to ensure everything is ready
  // Note: This will wait for transcription model to load (which can take time)
  setTimeout(() => {
    logInfo("🎤 Starting voice input pipeline initialization...");
    voiceInputPipeline.initialize().catch((error) => {
      logError("❌ Voice input pipeline initialization failed:", error);
    });
  }, 2000);

  logInfo("✅ AI Secretary Avatar initialized");

  return {
    avatar,
    chatBubble,
    toast,
    messageHistoryModal,
    inputModal,
    unifiedSettingsModal,
    progressModal,
    electronRpc,
  };
}

// Wait for Electron preload bridge to be ready
function waitForBridge(maxAttempts = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    const checkBridge = (): void => {
      attempts++;
      if (window.electronAPI) {
        logInfo("🔌 Electron preload bridge ready");
        resolve();
      } else if (attempts >= maxAttempts) {
        reject(new Error("Electron preload bridge not found after " + maxAttempts + " attempts"));
      } else {
        setTimeout(checkBridge, 100);
      }
    };

    checkBridge();
  });
}

// Initialize function
async function startApp() {
  try {
    await waitForBridge();
    initializeApp();
  } catch (error) {
    logError("Failed to initialize AI Secretary:", error);
    // Show error on page
    const app = document.getElementById("app");
    if (app) {
      app.innerHTML = `
        <div style="padding: 20px; color: red; font-family: system-ui;">
          <h2>Error Loading AI Secretary</h2>
          <p>${error instanceof Error ? error.message : String(error)}</p>
          <p>Check console for details.</p>
        </div>
      `;
    }
  }
}

// Initialize when DOM is ready and bridge is available
// For type="module" scripts, the DOM is already parsed when the module runs,
// but we check readyState just to be safe
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startApp);
} else {
  // DOM already loaded (common for module scripts)
  startApp();
}
