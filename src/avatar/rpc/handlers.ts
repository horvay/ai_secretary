/**
 * Avatar RPC Handlers
 * Message handlers for backend-frontend communication
 */

import { logDebug, logInfo, logWarn, logError } from "../utils/logger";
import { playAudio, stopAudio, clearPlaybackSuppression } from "../services/audioPlayer";
import { createTurnController } from "../services/turnController";
import type { AvatarInstance, AvatarState, AvatarStatus } from "../components/Avatar";
import type { ChatBubbleInstance } from "../components/ChatBubble";
import type { ProgressModalInstance } from "../components/ProgressModal";
import type { AgentActivityModalInstance } from "../components/AgentActivityModal";
import type { ToastInstance } from "../components/Toast";
import type { MessageHistoryModalInstance } from "../components/MessageHistoryModal";
import type { TranscriptionInstance } from "../services/transcription";

/**
 * Dependencies for creating RPC message handlers
 */
export interface RPCMessageHandlerDeps {
  avatar: AvatarInstance;
  chatBubble: ChatBubbleInstance;
  toast: ToastInstance;
  progressModal: ProgressModalInstance;
  agentActivityModal: AgentActivityModalInstance;
  messageHistoryModal: MessageHistoryModalInstance;
  transcription: TranscriptionInstance;
  askQuestion: (
    question: string,
    includeScreenshot: boolean,
    activeWindowOnly: boolean,
    options?: {
      source?: "text" | "voice" | "routine" | "reminder" | "system";
      showUserQuestion?: boolean;
      historyLabel?: string;
      voiceMode?: "normal" | "ari-decides";
    },
  ) => Promise<{ response: string; delivered: boolean; visibleText: boolean; audible: boolean }>;
  triggerReconcileProfile: () => Promise<void>;
  takeScreenshot: (filePath: string) => Promise<void>;
  openSettings: (tab?: "settings" | "debug") => Promise<void>;
  responseHideTimeout: { current: number | null };
  previousAvatarState: { current: AvatarState };
  isProcessingAI: { current: boolean };
  restartMicrophoneListening: () => void;
  /** Stop microphone listening (during TTS playback) */
  stopMicrophoneListening: () => void;
  /** Trigger follow-up mode (timer starts when TTS finishes) */
  activateFollowupMode: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  electronRpc: any; // ElectronRpc instance for RPC calls
  /** Start the reminder flashing effect */
  startFlashing: () => void;
}

/**
 * Create RPC message handlers
 */
export function createMessageHandlers(deps: RPCMessageHandlerDeps) {
  const {
    avatar,
    chatBubble,
    toast,
    progressModal,
    agentActivityModal,
    messageHistoryModal,
    transcription,
    askQuestion,
    triggerReconcileProfile,
    takeScreenshot,
    openSettings,
    responseHideTimeout,
    previousAvatarState,
    isProcessingAI,
    restartMicrophoneListening,
    stopMicrophoneListening,
    activateFollowupMode,
    electronRpc,
    startFlashing,
  } = deps;

  const applyState = (data: { state: AvatarState; turnId?: string; reason?: string }) => {
    const { state, reason } = data;
    const shouldActivateFollowupFromIdleReason =
      reason === "queue_empty_ai_complete" ||
      reason === "request_complete_audio_already_finished" ||
      reason === "no_audio_generated";

    if (state === "talking") {
      stopMicrophoneListening();
      logDebug(`🎤 Microphone stopped during TTS playback (reason=${reason ?? "unknown"})`);
    } else if (state === "idle") {
      isProcessingAI.current = false;
      // Redundant follow-up activation on terminal idle reasons.
      // This makes follow-up robust even if activateFollowupMode RPC
      // arrives late or is dropped by transport/race conditions.
      if (shouldActivateFollowupFromIdleReason) {
        activateFollowupMode();
      }
      setTimeout(() => {
        restartMicrophoneListening();
        logDebug(`🎤 Microphone restarted after TTS complete (reason=${reason ?? "unknown"})`);
      }, 300);
    }

    chatBubble.setSkipButtonVisible(state === "talking");

    if (state === "processing") {
      clearPlaybackSuppression();
    }

    previousAvatarState.current = state;
    avatar.setState(state);

    if (state === "idle") {
      stopAudio();
    }
  };

  const turnController = createTurnController({
    onApplyState: applyState,
    onActivateFollowup: () => activateFollowupMode(),
    logDebug,
  });

  return {
    setState: (data: { state: AvatarState | "thinking"; turnId?: string; reason?: string }) => {
      // Map "thinking" to "processing" for backwards compatibility
      const state: AvatarState = data.state === "thinking" ? "processing" : data.state;
      const { turnId, reason } = data;

      turnController.handleRemoteState({ state, turnId, reason });
    },

    activateFollowupMode: (data?: { turnId?: string; reason?: string }) => {
      turnController.handleRemoteFollowup({
        turnId: data?.turnId,
        reason: data?.reason,
      });
    },

    setAvatarStatus: (data: { status: AvatarStatus }) => {
      const status = (data?.status ?? "").toString();
      if (!status) return;
      avatar.setStatus(status);
    },

    setOverrideState: (data: { key: string }) => {
      // Cosmetic one-shot override; avatar component will auto-revert after one cycle.
      const key = (data?.key ?? "").toString();
      if (!key) return;
      avatar.setOverrideStateKey(key);
    },

    showResponse: (data: { text: string }) => {
      const text = (data?.text ?? "").toString();
      if (!text) {
        logDebug("[RPC showResponse] Received empty response text");
      }

      // Debug: log received text
      if (text.length > 0) {
        logDebug(
          `[RPC showResponse] Received text length: ${text.length}, first 100 chars: "${text.substring(0, 100)}..."`
        );
      }

      // Clear previous timeout before setting new one
      if (responseHideTimeout.current) {
        clearTimeout(responseHideTimeout.current);
      }
      chatBubble.show(text);
      // Auto-hide after 60 seconds (or until next question)
      responseHideTimeout.current = setTimeout(() => {
        chatBubble.hide();
        responseHideTimeout.current = null;
      }, 60000) as unknown as number;
    },

    appendResponse: (data: { delta: string }) => {
      const delta = (data?.delta ?? "").toString();
      if (!delta) return;
      chatBubble.append(delta);
    },

    showUserQuestion: (data: { question: string }) => {
      const question = (data?.question ?? "").toString();
      if (!question) {
        logWarn("[RPC showUserQuestion] Received empty question text");
        return;
      }
      logDebug(`[RPC showUserQuestion] Showing user question: "${question.substring(0, 50)}..."`);
      chatBubble.showUserQuestion(question);
    },

    error: (data: { message: string; type: string }) => {
      logError(`Error [${data.type}]:`, data.message);
      toast.show(`Error: ${data.message}`, 5000);
      avatar.setState("idle");
    },

    speakerAudioSegment: async (data: { base64: string; sampleRate: number; startedAt: number; endedAt: number; durationMs: number; captureBackend: string; deviceName?: string }) => {
      try {
        if (!transcription.isReady()) {
          logDebug("[SpeakerTranscript] Transcription model not ready, skipping speaker segment");
          return;
        }
        const binary = atob(data.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const audio = new Float32Array(bytes.buffer);
        const text = (await transcription.transcribe(audio)).trim();
        logInfo(`[SpeakerTranscript] STT result (${data.durationMs}ms via ${data.captureBackend}): "${text.substring(0, 160)}"`);
        if (!text) return;
        await electronRpc.current?.rpc.request.logAudioTranscript({
          source: "speaker",
          content: text,
          startedAt: data.startedAt,
          endedAt: data.endedAt,
          timestamp: data.endedAt,
          routedToAi: false,
          durationMs: data.durationMs,
          sampleRate: data.sampleRate,
          model: "parakeet.js",
          captureBackend: data.captureBackend,
          deviceName: data.deviceName,
        });
        logInfo(`[SpeakerTranscript] Saved speaker transcript: "${text.substring(0, 120)}"`);
      } catch (error) {
        logWarn("[SpeakerTranscript] Failed to process speaker segment:", error);
      }
    },

    logMessage: (data: { level: string; message: string }) => {
      // Route to appropriate logger method based on level
      if (data.level === "error") {
        logError(`[${data.level}]`, data.message);
      } else if (data.level === "warn") {
        logWarn(`[${data.level}]`, data.message);
      } else {
        logDebug(`[${data.level}]`, data.message);
      }
    },

    initWithCliArgs: (data: {
      waitSeconds?: number;
      chatMessage?: string;
      includeScreenshot?: boolean;
      activeWindowOnly?: boolean;
      reconcileProfile?: boolean;
      checkReminders?: boolean;
      openModal?: "history" | "current-session" | "routines" | "lists" | "transcripts" | "tasks" | "reminders";
      openSettings?: boolean;
      settingsScroll?: number;
      takeScreenshot?: string;
      injectContext?: string;
      testSilent?: boolean;
      testInterruptSeconds?: number;
      testRapidQuestions?: string[];
      testInterruptThenChat?: {
        firstMessage: string;
        secondMessage: string;
        interruptAfterSeconds: number;
      };
    }) => {
      logInfo("📝 Received CLI args:", data);
      (window as unknown as { __aiSecretaryCliMode?: boolean }).__aiSecretaryCliMode = true;
      const waitMs = (data.waitSeconds || 0) * 1000;

      const scrollSettingsModal = async (scrollTop: number) => {
        await wait(200);
        const activeSettingsTab = document.querySelector("#settings-modal .tab-content.active") as HTMLElement | null;
        if (!activeSettingsTab) {
          logWarn("⚠️ Could not find active settings tab to scroll");
          return;
        }
        activeSettingsTab.scrollTop = Math.max(0, scrollTop);
        activeSettingsTab.dispatchEvent(new Event("scroll"));
        await wait(300);
        logInfo(`↕️ Scrolled settings modal to ${scrollTop}px`);
      };

      if (data.chatMessage) {
        // Wait specified seconds then send the message
        setTimeout(() => {
          logInfo("⏰ Sending CLI message:", data.chatMessage);
          askQuestion(data.chatMessage!, data.includeScreenshot ?? false, data.activeWindowOnly ?? false);

          // If testInterruptSeconds is set, trigger interrupt after N seconds
          if (data.testInterruptSeconds && data.testInterruptSeconds > 0) {
            logInfo(`🛑 Will trigger interrupt after ${data.testInterruptSeconds}s...`);
            setTimeout(async () => {
              logInfo("🛑 Triggering test interrupt!");
              try {
                if (electronRpc.current) {
                  stopAudio();
                  await electronRpc.current.rpc.request.interruptResponse({});
                  logInfo("✅ Interrupt request sent successfully");
                } else {
                  logError("Failed to interrupt: electronRpc not initialized");
                }
              } catch (err) {
                logError("Failed to send interrupt:", err);
              }
            }, data.testInterruptSeconds * 1000);
          }
        }, waitMs);
      }

      if (data.testRapidQuestions && data.testRapidQuestions.length >= 2) {
        const rapidBaseDelay = waitMs;
        const rapidStepMs = 250;
        data.testRapidQuestions.forEach((message, idx) => {
          setTimeout(() => {
            logInfo(`🧪 Rapid question #${idx + 1}: ${message}`);
            askQuestion(message, false, false);
          }, rapidBaseDelay + idx * rapidStepMs);
        });
      }

      if (data.testInterruptThenChat) {
        const { firstMessage, secondMessage, interruptAfterSeconds } = data.testInterruptThenChat;
        setTimeout(() => {
          logInfo(`🧪 Interrupt-then-chat test start: "${firstMessage}"`);
          askQuestion(firstMessage, false, false);

          setTimeout(async () => {
            logInfo(`🧪 Interrupting after ${interruptAfterSeconds}s, then sending follow-up`);
            try {
              stopAudio();
              if (electronRpc.current) {
                await electronRpc.current.rpc.request.interruptResponse({});
              }
            } catch (err) {
              logError("Interrupt-then-chat interrupt step failed:", err);
            }
            askQuestion(secondMessage, false, false);
          }, interruptAfterSeconds * 1000);
        }, waitMs);
      }

      if (data.reconcileProfile) {
        // Wait specified seconds then trigger reconcile profile
        setTimeout(async () => {
          logInfo("⏰ Triggering reconcile profile from CLI...");
          await triggerReconcileProfile();
        }, waitMs);
      }

      if (data.checkReminders) {
        setTimeout(() => {
          logInfo("⏰ Triggering routine reminder check from CLI...");
          electronRpc.current?.rpc.request.checkRoutineReminders({}).catch((error: unknown) => {
            logError("Failed to check routine reminders:", error);
          });
        }, waitMs);
      }

      if (data.openModal) {
        // Wait specified seconds then open the modal
        setTimeout(async () => {
          logInfo(`⏰ Opening modal: ${data.openModal}`);
          await messageHistoryModal.show();
          if (data.openModal !== "history") {
            const tab = document.querySelector(`[data-tab="${data.openModal}"]`) as HTMLElement;
            if (tab) {
              tab.click();
            }
          }
        }, waitMs);
      }

      const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const shouldScreenshotAfterSettings = Boolean(data.openSettings && data.takeScreenshot);

      if (data.openSettings) {
        // Wait specified seconds then open settings
        setTimeout(async () => {
          logInfo("⏰ Opening settings modal from CLI...");
          await openSettings();

          if (typeof data.settingsScroll === "number" && data.settingsScroll > 0) {
            await scrollSettingsModal(data.settingsScroll);
          }

          if (shouldScreenshotAfterSettings && data.takeScreenshot) {
            await wait(2500);
            logInfo(`📸 Taking screenshot after settings settled: ${data.takeScreenshot}`);
            await takeScreenshot(data.takeScreenshot);
          }
        }, waitMs);
      }

      if (data.takeScreenshot && !shouldScreenshotAfterSettings) {
        // Wait after modal opens, then take screenshot
        const screenshotDelay = data.openModal ? waitMs + 1800 : data.chatMessage ? waitMs + 18000 : waitMs;
        setTimeout(async () => {
          logInfo(`📸 Taking screenshot: ${data.takeScreenshot}`);
          await takeScreenshot(data.takeScreenshot!);
        }, screenshotDelay);
      }

      if (data.injectContext) {
        // Wait specified seconds then inject context without AI response
        setTimeout(async () => {
          logInfo(`📋 Injecting context: "${data.injectContext}"`);
          try {
            // electronRpc is passed as a reference object
            if (electronRpc.current) {
              const result = await electronRpc.current.rpc.request.injectContext({ text: data.injectContext! });
              logInfo(`📋 Context injection result:`, result);
            } else {
              logError("Failed to inject context: electronRpc not initialized");
            }
          } catch (err) {
            logError("Failed to inject context:", err);
          }
        }, waitMs);
      }

      if (data.testSilent) {
        // Wait specified seconds then send a message that should trigger a silent response
        setTimeout(() => {
          logInfo("🔇 Testing silent response...");
          // A simple "okay thanks" after an initial message should trigger [NO_RESPONSE]
          const prompt = "okay thanks";
          askQuestion(prompt, false, false);
        }, waitMs);
      }
    },

    agentUpdate: (data: {
      type: string;
      toolName?: string;
      message?: string;
      delta?: string;
      thought?: string;
      args?: unknown;
      result?: unknown;
      error?: string;
      callId?: string;
      partIndex?: number;
      fullText?: string;
    }) => {
      // Keep legacy compact research display for tool/process/complete only.
      logDebug(
        `[Agent] ${data.type}: toolName=${data.toolName}, message=${data.message}, error=${data.error}, args=${JSON.stringify(data.args)?.substring(0, 100)}`
      );

      // Always capture ALL details in the full-screen agent activity modal.
      agentActivityModal.addEvent({
        type: data.type as any,
        toolName: data.toolName,
        message: data.message,
        delta: data.delta,
        thought: data.thought,
        args: data.args,
        result: data.result,
        error: data.error,
        callId: data.callId,
        partIndex: data.partIndex,
        fullText: data.fullText,
      });
    },

    spriteProcessingProgress: (data: { step: string; progress: number }) => {
      logDebug(`[Sprites] ${data.step} (${Math.round(data.progress)}%)`);
      progressModal.updateProgress(data.step, data.progress);
    },

    spriteProcessingComplete: (data: { success: boolean; message: string }) => {
      logInfo(`[Sprites] Complete: ${data.success ? "✅" : "❌"} ${data.message}`);
      progressModal.setComplete(data.success, data.message);
    },

    showToast: (data: { message: string; duration?: number }) => {
      toast.show(data.message, data.duration || 4000);
    },

    triggerRoutineReminder: (data: { routines: Array<{ id: number; name: string; goal?: string; prompt?: string; triggerId: number; periodKey: string }> }) => {
      if (data.routines.length === 0) {
        logDebug("[Routines] No pending routines to remind about");
        return;
      }

      const routineTriggerIds = data.routines.map((routine) => routine.triggerId);
      logInfo(`[Routines] Triggering reminder for: ${data.routines.map((routine) => routine.name).join(", ")}`);

      // Create a natural prompt for the AI to execute the routine's goal/action prompt.
      const routineList = data.routines.map((routine) => routine.name).join(", ");
      const routineSpecs = data.routines
        .map((routine) => `- ${routine.name}: goal=${routine.goal ?? routine.name}; action=${routine.prompt ?? routine.goal ?? routine.name}`)
        .join("\n");
      const prompt = `[SYSTEM: One or more goal-driven routines fired. Execute them naturally as Ari using available tools when useful. Respect the routine goal, don't merely say that a routine is due. Routines:\n${routineSpecs}]`;

      // Send to AI (no screenshot, no active window)
      const acknowledgeRoutineDelivery = (attempt = 1) => {
        const delayMs = Math.min(60_000, 1_000 * 2 ** (attempt - 1));
        const rpc = electronRpc.current?.rpc;
        if (!rpc) {
          logWarn(`[Routines] RPC unavailable for acknowledgement attempt ${attempt}, retrying in ${delayMs}ms...`);
          setTimeout(() => acknowledgeRoutineDelivery(attempt + 1), delayMs);
          return;
        }

        rpc.request.acknowledgeRoutineTriggers({ ids: routineTriggerIds })
          .then((result: { acknowledgedCount: number }) => {
            if (result.acknowledgedCount !== routineTriggerIds.length) {
              throw new Error(`Acknowledged ${result.acknowledgedCount}/${routineTriggerIds.length} routine triggers`);
            }
          })
          .catch((error: unknown) => {
            logWarn(`[Routines] Failed to acknowledge routine reminders (attempt ${attempt}), retrying in ${delayMs}ms...`, error);
            setTimeout(() => acknowledgeRoutineDelivery(attempt + 1), delayMs);
          });
      };

      askQuestion(prompt, false, false, {
        source: "routine",
        showUserQuestion: false,
        historyLabel: `Routine reminder: ${routineList}`,
      }).then((result) => {
        if (!result.delivered) {
          throw new Error("Routine reminder was not delivered to the user");
        }
        acknowledgeRoutineDelivery();
      }).catch((error: unknown) => {
        logWarn("[Routines] Routine reminder delivery failed, marking for retry:", error);
        electronRpc.current?.rpc.request.failRoutineTriggers({ ids: routineTriggerIds }).catch((failError: unknown) => {
          logWarn("[Routines] Failed to mark routine reminders as failed:", failError);
        });
      });
    },

    triggerOneTimeReminders: (data: { reminders: Array<{ id: number; content: string }> }) => {
      if (data.reminders.length === 0) {
        logDebug("[Reminders] No pending reminders to remind about");
        return;
      }

      logInfo(`[Reminders] Triggering reminder for: ${data.reminders.map((r) => r.content).join(", ")}`);

      // Start the flashing effect to grab user's attention
      startFlashing();

      const reminderIds = data.reminders.map((r) => r.id);

      // Create a natural prompt for the AI to respond to
      const reminderList = data.reminders.map((r) => r.content).join(", ");
      const prompt = `[SYSTEM: The user set some one-time reminders or timers that are due now: ${reminderList}. Please tell them about these reminders in your cute, playful secretary way! You should be bubbly and maybe a little mischievous about interrupting them. The app is flashing to get their attention!]`;

      // Send to AI (no screenshot, no active window)
      askQuestion(prompt, false, false, {
        source: "reminder",
        showUserQuestion: false,
        historyLabel: `One-time reminder: ${reminderList}`,
      }).then((result) => {
        if (!result.delivered) {
          throw new Error("Reminder prompt was not delivered to the user; leaving reminder retryable");
        }
        electronRpc.current?.rpc.request.acknowledgeReminders({ ids: reminderIds }).catch((error: unknown) => {
          logWarn("[Reminders] Failed to acknowledge reminders:", error);
        });
      }).catch((error: unknown) => {
        logWarn("[Reminders] Reminder delivery failed, leaving reminders retryable:", error);
      });
    },
  };
}

/**
 * Create request handlers
 */
export function createRequestHandlers() {
  return {
    playAudio: async (data: { audioData: string; volume?: number; rate?: number }) => {
      await playAudio(data.audioData, data.volume, data.rate);
    },
  };
}

