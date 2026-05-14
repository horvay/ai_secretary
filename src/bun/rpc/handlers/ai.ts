import { logDebug, logInfo, logWarn, logError } from "../../utils/logger";
import { logAgentEvent } from "../../utils/agentLogger";
import { logVoiceTurnEvent } from "../../utils/voiceTurnLogger";
import { AudioQueue, stopCurrentAudio } from "../../services/audio";
import { createSentenceBuffer } from "../../utils/sentenceBuffer";
import {
  cleanDeltaForTTS,
  cleanDeltaForDisplay,
  cleanResponseForDisplay,
  findAnimMarkers,
  findStateMarkers,
  isSilentResponse,
  stripAnimMarkers,
  stripStateMarkers,
  stripSilentPrefix,
} from "../../utils/textProcessing";
import type { PiperTTSInstance } from "../../services/piper";
import type { AgentClientInstance } from "../../services/agent/types";
import type { AppRpc } from "../../types/app-rpc";
import { screenshotService } from "../../services/screenshot";
import { spritesService } from "../../services/sprites";
import { clearSpeakerCaptureSuppression, suppressSpeakerCaptureForAriTts } from "../../services/speakerCapture";
import type { Mutex } from "../../utils/mutex";
import { validateString } from "../../utils/validation";
import { isConversationMemoryEnabled, logInteraction, saveScreenshot } from "../../services/memory";
import { finishConversationTurn, startConversationTurn } from "../../services/conversations";
import { getActiveCompanionPack, getCompanionPackMarkerSets } from "../../services/companion-packs";
import { getAppState, setAppState } from "../../services/app-state";
import { buildGBrainContext } from "../../services/gbrain";
import { runAriVoiceJsonTurn } from "../../services/ariVoiceJsonService";
import {
  clearActiveTurnFinalizer,
  clearActiveTurnIfCurrent,
  getActiveTurnId,
  isActiveTurn,
  nextTurnId,
  setActiveTurnFinalizer,
  setActiveTurnId,
} from "../../features/assistant-turn/turnLifecycle";
import {
  clearCurrentAbortController,
  clearCurrentAudioQueue,
  getCurrentAbortController,
  getWasInterrupted,
  interruptCurrentResponse,
  markInterrupted,
  setCurrentAbortController,
  setCurrentAudioQueue,
} from "../../features/assistant-turn/interruptController";

export { interruptCurrentResponse };

type Rpc = AppRpc;

/**
 * Format a message with a timestamp prefix for temporal awareness
 * @param message - The message to prefix
 * @returns Message with timestamp like "[10:34 AM] message"
 */
export function formatMessageWithTimestamp(message: string): string {
  const now = new Date();
  const time = now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `[${time}] ${message}`;
}

/**
 * Silent response prefix length - used for early detection during streaming
 */
const NO_RESPONSE_PREFIX_LENGTH = 13; // "[NO_RESPONSE]".length

export interface AiHandlerDeps {
  piperTTS: PiperTTSInstance;
  getAgentClient: () => Promise<AgentClientInstance>;
  rpc: Rpc;
  ttsMutex: Mutex;
}

export function createAiHandlers({ piperTTS, getAgentClient, rpc, ttsMutex }: AiHandlerDeps) {
  return {
    // AI Interaction
    askQuestion: async ({
      question,
      includeScreenshot,
      activeWindowOnly,
      source = "text",
      showUserQuestion = true,
      historyLabel,
      voiceMode = "normal",
    }: {
      question: string;
      includeScreenshot?: boolean;
      activeWindowOnly?: boolean;
      source?: "text" | "voice" | "routine" | "reminder" | "system";
      showUserQuestion?: boolean;
      historyLabel?: string;
      voiceMode?: "normal" | "ari-decides";
    }) => {
      // Validate input to prevent abuse
      const questionValidation = validateString(question, {
        maxLength: 50000, // Reasonable limit for questions
        required: true,
        name: "question",
      });

      if (!questionValidation.valid) {
        logWarn(`[RPC] askQuestion validation failed: ${questionValidation.error}`);
        throw new Error(questionValidation.error);
      }

      const sanitizedQuestion = questionValidation.sanitized!;
      logInfo(`[RPC] askQuestion received: "${sanitizedQuestion.substring(0, 100)}${sanitizedQuestion.length > 100 ? "..." : ""}"`);

      const turnId = nextTurnId();
      const turnStartMs = Date.now();

      const isCurrentTurn = () => isActiveTurn(turnId);
      const sendState = (
        state: "idle" | "processing" | "talking",
        reason: string,
      ) => {
        if (!isCurrentTurn()) return;
        rpc.send.setState({ state, turnId, reason });
        logVoiceTurnEvent({
          ts: new Date().toISOString(),
          turnId,
          event: "turn_state",
          source: "ai",
          to: state,
          reason,
          elapsedMs: Date.now() - turnStartMs,
        });
        // Keep turn ownership until we actually return to idle, so late
        // onChunkStarted/onQueueEmpty callbacks for this turn are still valid.
        if (state === "idle" && isActiveTurn(turnId)) {
          setActiveTurnId(null);
        }
      };

      const activateFollowup = (reason: string) => {
        if (!isCurrentTurn()) return;
        rpc.send.activateFollowupMode({ turnId, reason });
      };

      const sendAgentUpdate = (payload: any, reason?: string) => {
        if (!isCurrentTurn()) return;
        rpc.send.agentUpdate({ ...payload, turnId, reason });
      };

      logVoiceTurnEvent({
        ts: new Date().toISOString(),
        turnId,
        event: "turn_start",
        source: "ai",
        reason: "ask_question",
        details: { questionPreview: sanitizedQuestion.substring(0, 120) },
      });

      const isAriDecidesVoice = source === "voice" && voiceMode === "ari-decides";
      let shouldShowUserQuestion = showUserQuestion && !isAriDecidesVoice;
      let decisionMetadata: Record<string, unknown> | undefined;
      let conversationTurnId: string | null = null;
      let conversationSessionId: string | null = null;

      try {
        // Cancel any previous query/audio before starting new question
        interruptCurrentResponse("new_turn_started"); // Unified stopper cancels previous AudioQueue and AbortController

        // Mark this turn as active AFTER cancelling the previous one.
        // (interruptCurrentResponse clears activeTurnId by design)
        setActiveTurnId(turnId);

        // Create new AbortController for this request
        setCurrentAbortController(new AbortController());
        let activeSignal = getCurrentAbortController()!.signal;

        // Set avatar to processing state
        sendState("processing", "ask_started");

        // Capture screenshot before agent routing so both normal and ari-decides voice turns can use it.
        let screenshot: string | undefined;
        if (includeScreenshot) {
          try {
            screenshot = activeWindowOnly
              ? await screenshotService.captureActiveWindow()
              : await screenshotService.capture();
          } catch (error) {
            logWarn("Screenshot capture failed:", error);
          }
        }

        // Get agent client before optional display/logging. ari-decides voice turns run a
        // hidden JSON decision pass first so overheard speech does not flicker in UI/history.
        const client = await getAgentClient();

        if (isAriDecidesVoice) {
          const statusRaw = String(getAppState("secretary.status") ?? "normal").trim();
          const secretaryStatus = statusRaw.length > 0 ? statusRaw : "normal";
          logInfo(`[AriDecides] Running JSON-only voice turn for: "${sanitizedQuestion.substring(0, 100)}"`);

          const voiceResult = await runAriVoiceJsonTurn(client, {
            userSpeech: sanitizedQuestion,
            secretaryStatus,
            timestampedSpeech: formatMessageWithTimestamp(sanitizedQuestion),
            screenshot,
            signal: activeSignal,
          });

          decisionMetadata = {
            voiceMode,
            rawDecision: voiceResult.rawResponse,
            parsedDecision: voiceResult.raw,
            shouldRespond: voiceResult.shouldRespond,
          };

          if (!voiceResult.shouldRespond) {
            logInfo(`[AriDecides] JSON no_response (${voiceResult.reason})`);
            logInteraction({
              type: "context",
              role: "user",
              content: `[Overheard - no response]: ${sanitizedQuestion}`,
              sequence: 1,
              kind: "context",
              modality: "voice",
              source,
              metadata: decisionMetadata,
            });
            sendState("idle", "ari_decides_json_no_response");
            sendAgentUpdate({ type: "complete", message: "Done (no response)" }, "ari_decides_json_no_response");
            clearCurrentAudioQueue();
            clearCurrentAbortController();
            clearActiveTurnFinalizer();
            return { response: voiceResult.rawResponse, delivered: false, visibleText: false, audible: false };
          }

          logInfo(`[AriDecides] JSON respond (confidence=${voiceResult.raw.confidence}): ${voiceResult.reason}`);

          // The JSON pass is only a voice routing gate. Do not use its `speech` as the
          // final answer: it cannot call tools, so it can otherwise say "I'll check"
          // and then stop. Once it decides the user is addressing Ari, fall through to
          // the normal agent path so web search, memory, Playwright, reminders, etc.
          // can actually run before Ari answers.
          shouldShowUserQuestion = showUserQuestion;
        }

        // Show the user's question above the chat bubble unless this is a deferred silent candidate.
        if (shouldShowUserQuestion) {
          rpc.send.showUserQuestion({ question: sanitizedQuestion });
        }

        // Create an app-level conversation turn and log the initiating event.
        try {
          if (isConversationMemoryEnabled()) {
            const piSessionId = await client.getOrCreateSessionId();
            const turn = startConversationTurn({ piSessionId, source });
            conversationTurnId = turn.id;
            conversationSessionId = turn.session_id;
          }
          logInteraction({
            type: source === "voice" ? "voice" : "text",
            // Use user for hidden initiating prompts too: older memory.db files were created
            // before system/tool roles and still enforce a narrower CHECK constraint.
            role: "user",
            content: shouldShowUserQuestion ? sanitizedQuestion : (historyLabel ?? sanitizedQuestion),
            sessionId: conversationSessionId ?? undefined,
            turnId: conversationTurnId ?? undefined,
            sequence: 1,
            kind: "message",
            modality: source === "voice" ? "voice" : "text",
            source,
            metadata: decisionMetadata,
          });
        } catch (memErr) {
          logWarn("[RPC] Failed to create/log conversation turn:", memErr);
        }

        if (screenshot) {
          await saveScreenshot({
            imageData: screenshot,
            sessionId: conversationSessionId ?? undefined,
            turnId: conversationTurnId ?? undefined,
            source,
            metadata: {
              activeWindowOnly: !!activeWindowOnly,
              capturedFor: "askQuestion",
            },
          });
        }

        const activeCompanionPack = await getActiveCompanionPack();
        const allowedMarkers = getCompanionPackMarkerSets(activeCompanionPack);

        // === Streaming TTS Pipeline ===
        // Buffer sentences as they stream in, generate TTS in batches
        const sentenceBuffer = createSentenceBuffer({
          minSentences: 1,
          wordCountFailsafe: 250,
        });
        const MAX_TTS_SENTENCES = 1;

        let accumulatedText = "";
        let aiStreamComplete = false;
        let firstBatchStarted = false;
        let talkingSent = false;
        let streamEventCount = 0;
        let streamWatchdogId: ReturnType<typeof setTimeout> | null = null;
        let assistantFinalized = false;
        const deliveredAudioTexts: string[] = [];
        let finalGeneratedVisibleText = "";
        let responseTextForFinalization = "";

        const finalizeAssistantTurnOnce = (reason: string) => {
          if (assistantFinalized) return;
          assistantFinalized = true;
          const spokenText = deliveredAudioTexts.join(" ").replace(/\s+/g, " ").trim();
          const contentToLog = spokenText.length > 0 ? spokenText : finalGeneratedVisibleText.trim();
          try {
            if (contentToLog.length > 0) {
              logInteraction({
                type: "text",
                role: "assistant",
                content: contentToLog,
                sessionId: conversationSessionId ?? undefined,
                turnId: conversationTurnId ?? undefined,
                sequence: 2,
                kind: "message",
                modality: "text",
                source: "assistant",
                metadata: {
                  finalizedReason: reason,
                  generatedLength: responseTextForFinalization.length,
                  deliveredByAudioChunks: deliveredAudioTexts.length,
                  interrupted: reason.includes("interrupt"),
                },
              });
            }
            if (conversationTurnId) finishConversationTurn(conversationTurnId, reason.includes("interrupt") ? "interrupted" : "completed");
          } catch (memErr) {
            logWarn("[RPC] Failed to finalize assistant response in memory:", memErr);
          }
        };

        setActiveTurnFinalizer(finalizeAssistantTurnOnce);

        // Track the last marker-stripped fullText so we can compute stable deltas even if
        // markers appear (which may cause the stripped text length to decrease).
        let lastNoMarkerFullText = "";

        // Track the last displayed text so we only update UI when content changes
        let lastDisplayedText = "";

        // Track handled markers so we trigger each marker occurrence at most once
        const handledAnimMarkers = new Set<string>(); // `${key}@${index}`
        const handledStateMarkers = new Set<string>(); // `${status}@${index}`
        const lastAnimPlayAtByKey = new Map<string, number>();
        const ANIM_DEBOUNCE_MS = 5000;

        function longestCommonPrefixLen(a: string, b: string): number {
          const max = Math.min(a.length, b.length);
          let i = 0;
          while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
          return i;
        }

        function normalizeTtsText(text: string): string {
          return text.replace(/\s+/g, " ").trim();
        }

        function tryTriggerOneShotOverride(key: string, source: string): void {
          const raw = getAppState("avatarOverride.allowAi");
          const allowAi = raw === "1" || raw === "true";
          if (!allowAi) return;

          const now = Date.now();
          const last = lastAnimPlayAtByKey.get(key) ?? 0;
          if (now - last < ANIM_DEBOUNCE_MS) return;
          lastAnimPlayAtByKey.set(key, now);

          void spritesService
            .overrideFolderExists(key)
            .then((ok) => {
              if (!ok) {
                logWarn(`[Ari] [anim] folder not found for key="${key}" (source=${source})`);
                return;
              }
              logInfo(`[Ari] [anim] triggering one-shot override key="${key}" (source=${source})`);
              rpc.send.setOverrideState({ key });
            })
            .catch((err) => {
              logWarn("[Ari] [anim] override validation failed:", err);
            });
        }

        // Silent response detection - if response starts with [NO_RESPONSE], skip TTS
        let isSilentResponseDetected = false;
        let silentResponseChecked = false;

        type TtsSegment = {
          id: number;
          text: string;
          status: "pending" | "generating" | "queued" | "cancelled";
        };

        function createTurnTtsScheduler(audioQueue: AudioQueue) {
          const segments: TtsSegment[] = [];
          let nextSegmentId = 0;
          let drainPromise: Promise<void> | null = null;
          let kickAgain = false;
          let forceFlushRequested = false;
          let cancelled = false;

          const appendExtractedSegments = (forceFlush: boolean) => {
            const sentences = forceFlush
              ? sentenceBuffer.flush()
              : sentenceBuffer.extractSentences(false).completeSentences;

            for (const sentence of sentences) {
              const text = normalizeTtsText(sentence);
              if (!text) continue;
              segments.push({ id: ++nextSegmentId, text, status: "pending" });
            }
          };

          const hasPendingWork = () =>
            !sentenceBuffer.isEmpty() || segments.some((segment) => segment.status === "pending" || segment.status === "generating");

          const drainLoop = async (reason: string) => {
            logDebug(`🔮 TTS scheduler kicked (${reason})`);

            while (!cancelled && !audioQueue.wasCancelled() && !isSilentResponseDetected) {
              kickAgain = false;
              appendExtractedSegments(forceFlushRequested);
              forceFlushRequested = false;

              let generatedAny = false;
              while (!cancelled && !audioQueue.wasCancelled() && !isSilentResponseDetected) {
                const segment = segments.find((candidate) => candidate.status === "pending");
                if (!segment) break;

                // Keep a small amount of generated audio ahead of playback. During final flush,
                // allow the scheduler to drain all pending text so the turn can finish cleanly.
                if (!aiStreamComplete && audioQueue.isCurrentlyPlaying() && audioQueue.getQueueSize() > 1) {
                  break;
                }

                segment.status = "generating";
                generatedAny = true;
                const ttsStart = Date.now();

                try {
                  const ttsResult = await piperTTS.speakBatch([segment.text]);
                  const ttsElapsedMs = Date.now() - ttsStart;
                  logDebug(`🎤 Generated TTS segment #${segment.id} (${ttsResult.duration.toFixed(2)}s, ttsMs: ${ttsElapsedMs})`);
                  if (!cancelled && !audioQueue.wasCancelled()) {
                    segment.status = "queued";
                    audioQueue.enqueue(ttsResult.audioData, segment.text);
                  } else {
                    segment.status = "cancelled";
                  }
                } catch (error) {
                  segment.status = "cancelled";
                  logWarn(`TTS segment #${segment.id} generation failed:`, error);
                }
              }

              if (!kickAgain) {
                if (!generatedAny) logDebug(`🔮 TTS scheduler idle (${reason})`);
                break;
              }
            }
          };

          const kick = (reason: string) => {
            if (cancelled || audioQueue.wasCancelled() || isSilentResponseDetected) return drainPromise ?? Promise.resolve();
            if (drainPromise) {
              kickAgain = true;
              return drainPromise;
            }
            drainPromise = drainLoop(reason).finally(() => {
              drainPromise = null;
              if (kickAgain && !cancelled && !audioQueue.wasCancelled() && !isSilentResponseDetected) {
                void kick("queued_kick");
              }
            });
            return drainPromise;
          };

          return {
            appendAudioText(text: string) {
              if (cancelled || isSilentResponseDetected) return;
              const normalized = normalizeTtsText(text);
              if (!normalized) return;
              sentenceBuffer.append(normalized);
            },
            kick,
            async finishAndFlush() {
              if (cancelled || audioQueue.wasCancelled() || isSilentResponseDetected) return;
              forceFlushRequested = true;
              kickAgain = true;
              await kick("final_flush");
            },
            cancel() {
              cancelled = true;
              sentenceBuffer.clear();
              for (const segment of segments) {
                if (segment.status === "pending" || segment.status === "generating") segment.status = "cancelled";
              }
            },
            isBusy() {
              return drainPromise !== null || segments.some((segment) => segment.status === "generating");
            },
            hasPendingWork,
          };
        }

        let ttsScheduler: ReturnType<typeof createTurnTtsScheduler>;

        // Reset interrupt flag for new request
        markInterrupted(false);

        // Create audio queue with state callbacks and store module-level reference
        const audioQueue = new AudioQueue({
          playAudio: async (audioData) => {
            // Use webview for playback to support real-time volume/mute control
            const playbackStart = Date.now();
            logDebug("🔊 Sending playAudio RPC to webview...");
            await rpc.request.playAudio({
              audioData,
              volume: 1.0,
              rate: 1.25 // Standard rate for Ari
            });
            const playbackElapsedMs = Date.now() - playbackStart;
            logDebug(`🔊 playAudio RPC completed (playbackMs: ${playbackElapsedMs})`);
          },
          onPlaybackStart: () => {
            try {
              if (!isCurrentTurn()) return;
              if (!firstBatchStarted) {
                firstBatchStarted = true;
              }
              suppressSpeakerCaptureForAriTts(10_000);
              if (!talkingSent) {
                sendState("talking", "first_audio_chunk_started");
                logInfo("🎤 Audio playback started - avatar now talking; speaker capture suppressed");
                talkingSent = true;
              }
            } catch (err) {
              logError("onPlaybackStart error:", err);
            }
          },
          onPlaybackComplete: (item) => {
            if (!isCurrentTurn()) return;
            if (item.text) {
              deliveredAudioTexts.push(item.text);
              logDebug(`🧾 Delivered audio chunk text (${item.id}): "${item.text.substring(0, 80)}"`);
            }
          },
          onChunkStarted: () => {
            if (!isCurrentTurn()) return;
            suppressSpeakerCaptureForAriTts(10_000);
            // When a chunk starts playing, immediately try to pre-generate the next one
            // This gives us the entire duration of this chunk to have audio ready
            if (!isSilentResponseDetected && !audioQueue.wasCancelled()) {
              logDebug(`🔮 Chunk started - kicking TTS scheduler...`);
              ttsScheduler?.kick("chunk_started").catch((err) => {
                logError("TTS scheduler error:", err);
              });
            }
          },
          onQueueLow: () => {
            if (!isCurrentTurn()) return;
            // Queue is running low (0-1 items) - aggressively pre-generate
            if (!isSilentResponseDetected && !audioQueue.wasCancelled() && !aiStreamComplete) {
              logDebug(`⚡ Queue low - kicking TTS scheduler...`);
              ttsScheduler?.kick("queue_low").catch((err) => {
                logError("Queue-low TTS scheduler error:", err);
              });
            }
          },
          onQueueEmpty: () => {
            try {
              if (!isCurrentTurn()) return;
              // When the queue empties, we may be in one of these situations:
              // - AI is still streaming: audio gaps are expected, stay talking.
              // - AI is complete but we still have buffered text: force-flush TTS.
              // - Everything is complete: go idle.
              //
              // Important: the queue can become empty BEFORE `aiStreamComplete` flips true.
              // If that happens and we "stay talking", we MUST still transition to idle later
              // when the request completes (handled below near the end of askQuestion).

              // AI is done: if we still have buffered text, force a final TTS flush.
              if (aiStreamComplete && ttsScheduler?.hasPendingWork()) {
                logDebug("🔇 Queue empty and AI complete, but text remains - forcing final TTS flush");
                ttsScheduler.finishAndFlush().catch((err) => {
                  logError("Final flush TTS scheduler error:", err);
                });
                return;
              }

              // If still streaming and we have buffered text, ask the scheduler for more work.
              if (!aiStreamComplete && ttsScheduler?.hasPendingWork()) {
                logDebug("🔇 Queue empty while streaming, buffer has text -> kicking TTS scheduler");
                ttsScheduler.kick("queue_empty_while_streaming").catch((err) => {
                  logError("Queue-empty TTS scheduler error:", err);
                });
                return;
              }

              // Only go idle if audio work is complete and there's no buffered text left.
              if (!ttsScheduler?.isBusy() && !ttsScheduler?.hasPendingWork()) {
                if (aiStreamComplete) {
                  sendState("idle", "queue_empty_ai_complete");
                  clearSpeakerCaptureSuppression(1500);
                  // Start follow-up window when TTS playback is actually finished (queue empty).
                  activateFollowup("queue_empty_ai_complete");
                  finalizeAssistantTurnOnce("queue_empty_ai_complete");
                  clearActiveTurnFinalizer();
                  clearCurrentAudioQueue();
                  logInfo("🔇 Audio queue empty - avatar now idle");
                } else {
                  // If AI isn't done yet, stay talking (audio gaps are expected).
                  logInfo("🔇 Audio queue empty but AI still streaming - staying talking");
                }
              }
            } catch (err) {
              logError("onQueueEmpty error:", err);
            }
          },
          onQueueCancelled: () => {
            logInfo("🛑 Audio queue cancelled");
          },
          onQueueError: (err) => {
            logError("❌ Audio queue error:", err);
          },
        } as any);

        setCurrentAudioQueue(audioQueue);
        ttsScheduler = createTurnTtsScheduler(audioQueue);

        // The turn-local TTS scheduler owns sentence extraction and Piper generation.

        // Track audio queue and handle interrupts
        if (audioQueue.wasCancelled()) {
          logInfo("🛑 Audio queue cancelled before start");
        }

        // Start listening for AI stream events
        const unsubscribeAgentEvents = client.onAgentEvent((event) => {
          try {
            if (!isCurrentTurn()) return;
            streamEventCount += 1;
            logAgentEvent(event);
            switch (event.type) {
              case "text_delta": {
                if (getWasInterrupted()) return;
                const delta = event.delta ?? "";
                const fullText = event.fullText ?? "";

                // Track for debug
                const partIndex = event.partIndex ?? "unknown";
                if (delta.length > 0) {
                  logDebug(`[RPC] text_delta [${partIndex}]: "${delta.replace(/\n/g, "\\n").substring(0, 80)}..."`);
                }

                accumulatedText += delta;

                // If this is the first content, display the chat bubble
                if (accumulatedText.length === delta.length) {
                  rpc.send.showResponse({ text: "" });
                }

                // Build clean string to speak/display (strip markers)
                // Use cleanResponseForDisplay to apply loose strippers that handle incomplete markers
                const strippedFull = cleanResponseForDisplay(fullText);

                // Compute stable delta so we can append to buffer even with marker deletions
                const lcp = longestCommonPrefixLen(lastNoMarkerFullText, strippedFull);
                const deltaNoMarker = strippedFull.substring(lcp);
                lastNoMarkerFullText = strippedFull;

                // Update UI with full cleaned response (use showResponse to replace content,
                // allowing marker prefixes like "[anim" to be removed when the full marker is detected)
                if (strippedFull !== lastDisplayedText) {
                  rpc.send.showResponse({ text: strippedFull });
                  lastDisplayedText = strippedFull;
                }

                // Silent response detection - if response starts with [NO_RESPONSE], skip TTS
                if (!silentResponseChecked && strippedFull.length >= NO_RESPONSE_PREFIX_LENGTH) {
                  silentResponseChecked = true;
                  if (isSilentResponse(strippedFull)) {
                    isSilentResponseDetected = true;
                    logInfo(`[Ari] 🔇 Silent response detected during streaming - skipping TTS`);
                  }
                }

                if (!isSilentResponseDetected) {
                  // Clean delta for TTS (remove markers, strip bracketed tool tags, etc)
                  const cleanedForTTS = cleanDeltaForTTS(deltaNoMarker);
                  if (cleanedForTTS) {
                    ttsScheduler.appendAudioText(cleanedForTTS);
                    ttsScheduler.kick("text_delta").catch((err) => logError("TTS scheduler error:", err));
                  }
                }

                // Handle animation markers
                if (fullText) {
                  const animMarkers = findAnimMarkers(fullText);
                  for (const { key, index, raw } of animMarkers) {
                    const markerId = `${key}@${index}`;
                    if (handledAnimMarkers.has(markerId)) continue;
                    handledAnimMarkers.add(markerId);
                    if (!allowedMarkers.animations.has(key)) {
                      logWarn(
                        `[Ari] Ignoring undeclared [anim:${key}] marker from pack ${activeCompanionPack.manifest.id}`,
                      );
                      continue;
                    }
                    tryTriggerOneShotOverride(key, raw);
                  }
                }

                // Handle avatar state markers
                if (fullText) {
                  const stateMarkers = findStateMarkers(fullText);
                  for (const { status, index } of stateMarkers) {
                    const markerId = `${status}@${index}`;
                    if (handledStateMarkers.has(markerId)) continue;
                    handledStateMarkers.add(markerId);
                    if (!allowedMarkers.states.has(status)) {
                      logWarn(
                        `[Ari] Ignoring undeclared [state:${status}] marker from pack ${activeCompanionPack.manifest.id}`,
                      );
                      continue;
                    }
                    try {
                      setAppState("secretary.status", status);
                    } catch (error) {
                      logWarn(`[Ari] Failed to persist secretary.status=${status}:`, error);
                    }
                    rpc.send.setAvatarStatus({ status });
                  }
                }
                break;
              }

              case "thought_delta": {
                if (event.thought) {
                  sendAgentUpdate({ type: "thought_delta", thought: event.thought }, "thought_delta");
                }
                break;
              }

              case "processing": {
                sendAgentUpdate({ type: "processing", message: event.message ?? "Processing..." }, "processing");
                break;
              }

              case "tool_start": {
                sendAgentUpdate({
                  type: "tool_start",
                  message: event.message ?? "Using tool...",
                  toolName: event.toolName,
                  args: event.args,
                }, "tool_start");
                break;
              }

              case "tool_end": {
                sendAgentUpdate({
                  type: "tool_end",
                  message: event.message ?? "Finished tool",
                  toolName: event.toolName,
                  args: event.args,
                  result: event.result,
                }, "tool_end");
                break;
              }

              case "error": {
                if (event.error) {
                  rpc.send.error({ message: event.error, type: "agent" });
                }
                // Cancel TTS pipeline on error
                ttsScheduler.cancel();
                audioQueue.cancel();
                sendState("idle", "agent_error_event");
                break;
              }
            }
          } catch (e) {
            logError("Error handling agent event:", e);
          }
        });

        // Query the agent backend (this now waits for the agent to complete)
        // User profile is injected into the system prompt via AGENTS.md.
        // Optional GBrain context is looked up here because the normal chat path
        // does not call the findMemoryContext RPC endpoint.
        // Add timestamp prefix for temporal awareness
        const statusRaw = String(getAppState("secretary.status") ?? "normal").trim();
        const secretaryStatus = statusRaw.length > 0 ? statusRaw : "normal";
        const timestampedQuestion = formatMessageWithTimestamp(sanitizedQuestion);
        const statusPrefixedQuestion = `[SecretaryStatus: ${secretaryStatus}] ${timestampedQuestion}`;
        const normalVoiceAgentInstruction = isAriDecidesVoice
          ? "[Voice router already approved this utterance. This is the real assistant turn now: answer Ari-style in natural language, not JSON. Do not mention the voice router. If the user asks for current/online info, use available tools before answering.]\n"
          : "";
        let queryForAgent = `${normalVoiceAgentInstruction}${statusPrefixedQuestion}`;

        const gbrainContext = await buildGBrainContext(sanitizedQuestion, activeSignal);
        if (activeSignal.aborted || !isCurrentTurn()) {
          logInfo(`[RPC] askQuestion aborted during GBrain context lookup for: "${sanitizedQuestion.substring(0, 50)}..."`);
          unsubscribeAgentEvents();
          if (conversationTurnId) finishConversationTurn(conversationTurnId, "interrupted");
          if (isActiveTurn(turnId)) {
            setActiveTurnId(null);
          }
          return { response: "", delivered: false, visibleText: false, audible: false };
        }
        if (gbrainContext.context) {
          logInfo(`[GBrain] Injecting context into turn ${turnId} (${gbrainContext.sourceCount} source(s): ${gbrainContext.slugs.join(", ")})`);
          sendAgentUpdate(
            {
              type: "processing",
              message: `Using long-term brain context (${gbrainContext.sourceCount} source${gbrainContext.sourceCount === 1 ? "" : "s"})...`,
            },
            "gbrain_context",
          );
          queryForAgent = `${gbrainContext.context}\n\nCurrent user question:\n${statusPrefixedQuestion}`;
        }

        let response;
        let recoveryAttempted = false;
        const STREAM_WATCHDOG_TIMEOUT_ERROR = "STREAM_WATCHDOG_TIMEOUT";

        const runQuery = async (signalToUse: AbortSignal, attempt: number) => {
          if (streamWatchdogId) {
            clearTimeout(streamWatchdogId);
          }

          let watchdogReject: ((error: Error) => void) | null = null;
          const watchdogPromise = new Promise<never>((_, reject) => {
            watchdogReject = reject;
            streamWatchdogId = setTimeout(() => {
              if (!isCurrentTurn()) return;
              if (streamEventCount === 0) {
                logWarn(`[RPC] No agent stream events for turn ${turnId}, aborting (attempt ${attempt})`);
                getCurrentAbortController()?.abort("stream_watchdog_timeout");
                watchdogReject?.(new Error(STREAM_WATCHDOG_TIMEOUT_ERROR));
              }
            }, 45000);
          });

          try {
            return await Promise.race([
              client.query(
                {
                  query: queryForAgent,
                  context: screenshot ? { screenshot } : undefined,
                },
                { signal: signalToUse },
              ),
              watchdogPromise,
            ]);
          } finally {
            watchdogReject = null;
            if (streamWatchdogId) {
              clearTimeout(streamWatchdogId);
              streamWatchdogId = null;
            }
          }
        };

        try {
          response = await runQuery(activeSignal, 1);
        } catch (queryErr) {
          const isWatchdogTimeout =
            queryErr instanceof Error && queryErr.message === STREAM_WATCHDOG_TIMEOUT_ERROR;
          if (isWatchdogTimeout && !recoveryAttempted && isCurrentTurn()) {
            recoveryAttempted = true;
            logWarn("[RPC] Stream watchdog timeout detected. Clearing agent session and retrying once.");
            sendAgentUpdate(
              {
                type: "processing",
                message: "Recovering agent session and retrying...",
              },
              "stream_watchdog_recover",
            );

            try {
              await client.clearSession();
              streamEventCount = 0;
              setCurrentAbortController(new AbortController());
              activeSignal = getCurrentAbortController()!.signal;
              response = await runQuery(activeSignal, 2);
            } catch (retryErr) {
              const retryWatchdogTimeout =
                retryErr instanceof Error && retryErr.message === STREAM_WATCHDOG_TIMEOUT_ERROR;
              if (retryWatchdogTimeout) {
                sendState("idle", "stream_watchdog_timeout");
                sendAgentUpdate(
                  {
                    type: "error",
                    error: "No response stream events received in time. Please retry.",
                  },
                  "stream_watchdog_timeout",
                );
              }

              if (retryWatchdogTimeout || activeSignal.aborted) {
                logInfo(`[RPC] askQuestion aborted after recovery attempt for: "${sanitizedQuestion.substring(0, 50)}..."`);
                unsubscribeAgentEvents();
                if (conversationTurnId) finishConversationTurn(conversationTurnId, "interrupted");
                if (isActiveTurn(turnId)) {
                  setActiveTurnId(null);
                }
                return { response: "", delivered: false, visibleText: false, audible: false };
              }
              throw retryErr;
            }
          } else if (activeSignal.aborted) {
            logInfo(`[RPC] askQuestion aborted for: "${sanitizedQuestion.substring(0, 50)}..."`);
            unsubscribeAgentEvents();
            if (conversationTurnId) finishConversationTurn(conversationTurnId, "interrupted");
            if (isActiveTurn(turnId)) {
              setActiveTurnId(null);
            }
            return { response: "", delivered: false, visibleText: false, audible: false };
          } else {
            throw queryErr;
          }
        }

        logInfo(`Question answered:\n${response.response}`);
        aiStreamComplete = true;
        if (streamWatchdogId) {
          clearTimeout(streamWatchdogId);
          streamWatchdogId = null;
        }

        // Check for silent response one more time (in case streaming didn't catch it)
        if (!silentResponseChecked && isSilentResponse(response.response)) {
          isSilentResponseDetected = true;
          logInfo(`[Ari] 🔇 Silent response detected in final response - skipping TTS`);
        }

        responseTextForFinalization = response.response;
        const finalVisibleText = cleanResponseForDisplay(stripSilentPrefix(response.response)).trim();
        finalGeneratedVisibleText = finalVisibleText;
        if (!isSilentResponseDetected && finalVisibleText.length > 0 && finalVisibleText !== lastDisplayedText) {
          rpc.send.showResponse({ text: finalVisibleText });
          lastDisplayedText = finalVisibleText;
        }
        const delivered = !isSilentResponseDetected && finalVisibleText.length > 0;
        const audible = delivered;

        // For silent responses, skip all TTS processing and go straight to idle
        if (isSilentResponseDetected) {
          logInfo(`[Ari] 🔇 Silent response complete - going idle without TTS`);
          ttsScheduler.cancel();
          audioQueue.cancel();
          sendState("idle", "silent_response");
          sendAgentUpdate({ type: "complete", message: "Done (silent)" }, "silent_response");

          finalGeneratedVisibleText = "";
          finalizeAssistantTurnOnce("silent_response");

          // Clean up module-level references
          clearCurrentAudioQueue();
          clearCurrentAbortController();
          clearActiveTurnFinalizer();
          unsubscribeAgentEvents();
          if (streamWatchdogId) {
            clearTimeout(streamWatchdogId);
            streamWatchdogId = null;
          }

          return {
            response: response.response,
            delivered: false,
            visibleText: false,
            audible: false,
          };
        }

        // Process any remaining text through the same scheduler path.
        if (!audioQueue.wasCancelled() && ttsScheduler.hasPendingWork()) {
          logDebug(`🎯 Final flush of remaining content...`);
          await ttsScheduler.finishAndFlush();
        }

        // If no audio was generated at all, just go idle
        if (audioQueue.isEmpty() && !firstBatchStarted) {
          sendState("idle", "no_audio_generated");
          finalizeAssistantTurnOnce("no_audio_generated");
          clearActiveTurnFinalizer();
          clearCurrentAudioQueue();
        }

        // If audio already finished BEFORE `aiStreamComplete` flipped true, `onQueueEmpty`
        // would have chosen "stay talking" and will not fire again. Ensure we still go idle.
        if (firstBatchStarted && aiStreamComplete && !ttsScheduler.isBusy() && !ttsScheduler.hasPendingWork() && audioQueue.isEmpty()) {
          sendState("idle", "request_complete_audio_already_finished");
          clearSpeakerCaptureSuppression(1500);
          // `onQueueEmpty` may have fired before `aiStreamComplete` flipped; ensure follow-up still starts.
          activateFollowup("request_complete_audio_already_finished");
          finalizeAssistantTurnOnce("request_complete_audio_already_finished");
          clearActiveTurnFinalizer();
          clearCurrentAudioQueue();
          logInfo("🔇 Audio already complete at end-of-request - avatar now idle");
        }

        // Send completion event
        sendAgentUpdate({ type: "complete", message: "Done" }, "request_complete");
        logVoiceTurnEvent({
          ts: new Date().toISOString(),
          turnId,
          event: "turn_end",
          source: "ai",
          reason: "request_complete",
          elapsedMs: Date.now() - turnStartMs,
        });

        // Clean up the abort controller on successful generation. Keep currentAudioQueue
        // until playback completes so interrupts can still cancel and finalize partial history.
        clearCurrentAbortController();
        if (streamWatchdogId) {
          clearTimeout(streamWatchdogId);
          streamWatchdogId = null;
        }

        unsubscribeAgentEvents();

        return {
          response: response.response,
          delivered,
          visibleText: finalVisibleText.length > 0,
          audible,
        };
      } catch (error) {
        if (conversationTurnId) {
          try {
            finishConversationTurn(conversationTurnId, "error");
          } catch (finishError) {
            logWarn("[RPC] Failed to finish conversation turn on error:", finishError);
          }
        }
        clearActiveTurnIfCurrent(turnId);
        // Clean up module-level references on error
        clearCurrentAudioQueue();
        clearCurrentAbortController();
        clearActiveTurnFinalizer();

        const errorMessage = error instanceof Error ? error.message : String(error);
        rpc.send.error({
          message: errorMessage,
          type: "agent",
        });
        logVoiceTurnEvent({
          ts: new Date().toISOString(),
          turnId,
          event: "turn_end",
          source: "ai",
          reason: "error",
          elapsedMs: Date.now() - turnStartMs,
          details: { errorMessage },
        });
        throw error;
      }
    },

    // TTS
    speakText: async ({ text, volume }: { text: string; volume?: number }) => {
      try {
        const result = await piperTTS.speak({ text, volume });
        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        rpc.send.error({
          message: errorMessage,
          type: "tts",
        });
        throw error;
      }
    },

    cancelTTS: async () => {
      try {
        piperTTS.cancel();
        return;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        rpc.send.error({
          message: errorMessage,
          type: "tts",
        });
        throw error;
      }
    },

    /**
     * Interrupt the current response - stops TTS, cancels audio queue, aborts AI generation
     * This is the unified interrupt handler for all interrupt triggers
     */
    interruptResponse: async () => {
      try {
        // Cancel Piper TTS generation FIRST - this stops new audio from being generated
        piperTTS.cancel();

        // Call the module-level interrupt function - stops audio queue and kills processes
        const wasActive = interruptCurrentResponse();

        // Kill audio again just to be sure
        stopCurrentAudio();

        // Set avatar to idle
        const interruptedTurnId = getActiveTurnId();
        rpc.send.setState({
          state: "idle",
          turnId: interruptedTurnId ?? undefined,
          reason: "interrupt_response_rpc",
        });
        if (interruptedTurnId) {
          logVoiceTurnEvent({
            ts: new Date().toISOString(),
            turnId: interruptedTurnId,
            event: "turn_state",
            source: "ai",
            to: "idle",
            reason: "interrupt_response_rpc",
          });
        }

        logInfo(`🛑 interruptResponse complete, wasActive: ${wasActive}`);

        return { interrupted: wasActive };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("interruptResponse failed:", errorMessage);
        rpc.send.error({
          message: errorMessage,
          type: "tts",
        });
        throw error;
      }
    },
  };
}
