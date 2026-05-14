import { describe, expect, test } from "bun:test";
import { createVoiceInputPipeline } from "./VoiceInputPipeline";

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function createPipelineHarness(transcript: string) {
  let speechStart: (() => void) | null = null;
  let speechEnd: ((audio: Float32Array) => void | Promise<void>) | null = null;
  let errorHandler: ((error: Error) => void) | null = null;
  const askCalls: Array<{ text: string; options?: { source?: string; voiceMode?: string } }> = [];
  const askDeferred = createDeferred<void>();

  const pipeline = createVoiceInputPipeline({
    avatar: {
      getState: () => "idle",
    } as any,
    chatBubble: {} as any,
    toast: { show: () => {} } as any,
    micManager: {
      isEnabled: () => true,
      getState: () => "listening",
      isListening: () => true,
      setIndicatorState: () => {},
      toggle: async () => {},
      stop: () => {},
      start: async () => {},
      onSpeechStart: (cb: () => void) => { speechStart = cb; },
      onSpeechEnd: (cb: (audio: Float32Array) => void | Promise<void>) => { speechEnd = cb; },
      onError: (cb: (error: Error) => void) => { errorHandler = cb; },
    } as any,
    transcription: {
      isReady: () => true,
      initialize: async () => {},
      transcribe: async () => transcript,
    } as any,
    electronRpc: {
      rpc: {
        request: {
          injectContext: async () => {},
          interruptResponse: async () => {},
        },
        send: { voiceActivity: () => {} },
      },
    },
    askQuestion: async (text, _includeScreenshot, _activeWindowOnly, options) => {
      askCalls.push({ text, options });
      askDeferred.resolve();
      return { response: "", delivered: false, visibleText: false, audible: false };
    },
    stopAudio: () => {},
    suppressPlayback: () => {},
    stopFlashing: () => {},
    responseHideTimeout: { current: null },
    errorHideTimeout: { current: null },
    logDebug: () => {},
    logInfo: () => {},
    logWarn: () => {},
    logError: () => {},
    isProcessingAI: { current: false },
  });

  pipeline.setupMicrophoneHandlers();

  return {
    pipeline,
    askCalls,
    askDeferred,
    emitSpeech: async () => {
      speechStart?.();
      await speechEnd?.(new Float32Array(16_000));
    },
    getHandlers: () => ({ speechStart, speechEnd, errorHandler }),
  };
}

describe("always-listening voice pipeline", () => {
  test("routes ordinary non-noise speech through Ari's JSON decision mode without wake-word gating", async () => {
    const harness = createPipelineHarness("Bob, the printer in accounting is out of paper.");

    await harness.emitSpeech();
    await harness.askDeferred.promise;

    expect(harness.askCalls).toHaveLength(1);
    expect(harness.askCalls[0]).toEqual({
      text: "Bob, the printer in accounting is out of paper.",
      options: { source: "voice", voiceMode: "ari-decides" },
    });
  });

  test("drops only hygiene noise before JSON routing", async () => {
    const harness = createPipelineHarness("um");

    await harness.pipeline.handleTranscribedText("um");

    expect(harness.askCalls).toHaveLength(0);
  });
});
