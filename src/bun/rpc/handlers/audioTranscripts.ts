import {
  getMicrophoneSendToAi,
  getRecentAudioTranscripts,
  getSpeakerTranscriptionEnabled,
  logAudioTranscript,
  searchAudioTranscripts,
  setMicrophoneSendToAi,
  setSpeakerTranscriptionEnabled,
  type AudioTranscriptSource,
  type AudioTranscriptSourceFilter,
} from "../../services/audioTranscripts";
import { startSpeakerCapture, stopSpeakerCapture } from "../../services/speakerCapture";

interface AudioTranscriptHandlerDeps {
  rpc?: {
    send: {
      speakerAudioSegment: (payload: { base64: string; sampleRate: number; startedAt: number; endedAt: number; durationMs: number; captureBackend: string; deviceName?: string }) => void;
    };
  };
}

function source(value: unknown): AudioTranscriptSourceFilter {
  return value === "microphone" || value === "speaker" || value === "all" ? value : "all";
}

export function createAudioTranscriptHandlers(deps: AudioTranscriptHandlerDeps = {}) {
  const syncSpeakerCapture = (enabled: boolean) => {
    if (!enabled) {
      stopSpeakerCapture();
      return;
    }
    if (!deps.rpc) return;
    void startSpeakerCapture({ sendSegment: (payload) => deps.rpc?.send.speakerAudioSegment(payload) }).catch((error) => {
      console.warn("[AudioTranscripts] Speaker capture failed to start; persisted setting remains enabled:", error);
    });
  };

  return {
    logAudioTranscript: async (params: {
      source: AudioTranscriptSource;
      content: string;
      startedAt?: number;
      endedAt?: number;
      timestamp?: number;
      appName?: string;
      windowTitle?: string;
      sessionId?: string;
      turnId?: string;
      routedToAi?: boolean;
      durationMs?: number;
      sampleRate?: number;
      model?: string;
      language?: string;
      confidence?: number;
      captureBackend?: string;
      deviceName?: string;
      metadata?: Record<string, unknown>;
    }) => ({ id: logAudioTranscript(params) }),

    searchAudioTranscripts: async (params: {
      query?: string;
      source?: AudioTranscriptSourceFilter;
      startTime?: number;
      endTime?: number;
      limit?: number;
    }) => ({
      results: searchAudioTranscripts({
        query: params.query ?? "",
        source: source(params.source),
        startTime: params.startTime,
        endTime: params.endTime,
        limit: params.limit,
      }),
    }),

    getRecentAudioTranscripts: async (params: {
      source?: AudioTranscriptSourceFilter;
      minutes?: number;
      limit?: number;
    }) => ({
      results: getRecentAudioTranscripts({
        source: source(params.source),
        minutes: params.minutes,
        limit: params.limit,
      }),
    }),

    getMicrophoneSendToAi: async () => ({ enabled: getMicrophoneSendToAi() }),
    setMicrophoneSendToAi: async ({ enabled }: { enabled: boolean }) => ({ enabled: setMicrophoneSendToAi(enabled) }),
    getSpeakerTranscriptionEnabled: async () => {
      const enabled = getSpeakerTranscriptionEnabled();
      syncSpeakerCapture(enabled);
      return { enabled };
    },
    setSpeakerTranscriptionEnabled: async ({ enabled }: { enabled: boolean }) => {
      const next = setSpeakerTranscriptionEnabled(enabled);
      syncSpeakerCapture(next);
      return { enabled: next };
    },
  };
}
