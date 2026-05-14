import { logDebug } from "../../utils/logger";
import type { PiperTTSInstance } from "../../services/piper";
import type { AgentClientInstance } from "../../services/agent/types";
import type { AppRpc } from "../../types/app-rpc";
import { createMutex } from "../../utils/mutex";
import { updateLastVoiceActivity } from "../../services/routines";
import { createAgentSettingsHandlers } from "./agent";
import { createAiHandlers, interruptCurrentResponse } from "./ai";
import { createMemoryHandlers } from "./memory";
import { createRoutinesHandlers } from "./routines";
import { createListsHandlers } from "./lists";
import { createTasksHandlers } from "./tasks";
import { createRemindersHandlers } from "./reminders";
import { createSettingsHandlers } from "./settings";
import { createSmokeHandlers } from "./smoke";
import { createAudioTranscriptHandlers } from "./audioTranscripts";

export { interruptCurrentResponse };

/**
 * Dependencies required by the RPC handlers
 */
export interface RPCHandlerDependencies {
  piperTTS: PiperTTSInstance;
  getAgentClient: () => Promise<AgentClientInstance>;
  getRpc: () => AppRpc;
  onWebviewReady?: () => void;
}

/**
 * Create the RPC request handlers
 * Note: getRpc is a getter function to handle the circular dependency
 * where handlers need rpc but are defined before rpc is created
 */
export function createRequestHandlers(deps: RPCHandlerDependencies) {
  const { piperTTS, getAgentClient, getRpc, onWebviewReady } = deps;

  // TTS mutex to prevent sentence loss during rapid processing
  const ttsMutex = createMutex("TTS");

  // Helper to get rpc (deferred to avoid circular dependency)
  const rpc = {
    get send() {
      return getRpc().send;
    },
    get request() {
      return getRpc().request;
    },
  };

  return {
    webviewReady: async () => {
      onWebviewReady?.();
    },
    ...createAgentSettingsHandlers({ getAgentClient }),
    ...createAiHandlers({ piperTTS, getAgentClient, rpc, ttsMutex }),
    ...createSettingsHandlers({ rpc, getAgentClient }),
    ...createMemoryHandlers({ getAgentClient }),
    ...createAudioTranscriptHandlers({ rpc }),
    ...createRoutinesHandlers(),
    ...createListsHandlers(),
    ...createTasksHandlers(),
    ...createRemindersHandlers(),
    ...createSmokeHandlers(),
  };
}

/**
 * Create the RPC message handlers
 */
export function createMessageHandlers() {
  return {
    "*": (messageName: string, payload: unknown) => {
      logDebug(`📨 Message received: ${messageName}`, payload);
    },
    windowFocus: () => {
      logDebug("🎯 Window focused");
      // Could enable click-through passthrough here if desired
    },
    windowBlur: () => {
      logDebug("👻 Window blurred - transparent mode");
      // Could enable click-through passthrough here if desired
    },
    voiceActivity: () => {
      logDebug("🎤 Voice activity detected");
      updateLastVoiceActivity();
    },
  };
}
