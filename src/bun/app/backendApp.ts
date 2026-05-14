import { logDebug, logInfo, logWarn, flushLogs } from "../utils/logger";
import { piperTTS } from "../services/piper";
import { stopCurrentAudio } from "../services/audio";
import { initMemory, shutdownMemory } from "../services/memory";
import { initializeAppStateDefaults } from "../services/app-state";
import { getProfileSummary, initProfile } from "../services/profile";
import { initAgentsTemplate } from "../services/agents-template";
import { setSchedulerRpc, startScheduler, stopScheduler, enableTestMode } from "../services/routineScheduler";
import { stopModelServer } from "../services/parakeet-models";
import { cleanupAllTempFiles } from "../utils/tempFiles";
import { cancelAllTasks, getActiveTasks, trackTask } from "../utils/taskTracker";
import { createError, ErrorCodes } from "../utils/errorHandler";
import type { CliArgs } from "../cli";
import type { AISecretaryRPC } from "../../shared/rpc";

type Rpc = {
  send: AISecretaryRPC["webview"]["messages"];
  request: AISecretaryRPC["webview"]["requests"];
};

export interface BackendAppDeps {
  rpc: Rpc;
  cliArgs: CliArgs;
  isWebviewReady: () => boolean;
}

export function createBackendApp({ rpc, cliArgs, isWebviewReady }: BackendAppDeps) {
  let activeAgentClient: Awaited<ReturnType<typeof import("../services/agent-client").getAgentClient>> | null = null;

  async function getAgentClient() {
    const module = await import("../services/agent-client");
    activeAgentClient = await module.getAgentClient();
    return activeAgentClient;
  }

  async function initialize() {
    trackTask("piper-init", (async () => {
      await piperTTS.initialize((progress) => logInfo(`📥 ${progress}`));
      try {
        const warmed = await piperTTS.speakBatch(["Voice ready."]);
        logInfo(`🔊 Speaking model warmed (${warmed.duration.toFixed(2)}s audio generated)`);
      } catch (error) {
        logWarn("Speaking model warmup failed; TTS will retry on first response:", error);
      }
    })()).catch((error) => {
      createError(ErrorCodes.TTS_INIT_FAILED, error instanceof Error ? error.message : String(error), { severity: "warning", recoverable: true });
    });

    await initMemory();
    initializeAppStateDefaults();
    await initProfile();
    logDebug("📋 User profile loaded:", await getProfileSummary());
    await initAgentsTemplate();
    setSchedulerRpc(rpc as never);
    if (cliArgs.testSchedulerInterval) enableTestMode(cliArgs.testSchedulerInterval * 1000);
    startScheduler();

    const client = await getAgentClient();
    client.onProgress((message) => {
      logInfo(`🤖 ${message}`);
      if (isWebviewReady()) rpc.send.logMessage({ level: "info", message: `pi: ${message}` });
    });
    await trackTask("agent-backend-start", client.startServer());
    logInfo("✅ pi backend started");
  }

  async function shutdown(server?: { stop(force?: boolean): void }) {
    logInfo("🛑 Shutting down Electron backend...");
    stopScheduler();
    stopCurrentAudio();
    await activeAgentClient?.stopServer().catch((error) => logWarn("Agent shutdown failed:", error));
    stopModelServer();
    await cancelAllTasks("app shutdown");
    const remainingTasks = getActiveTasks();
    if (remainingTasks.length > 0) logWarn("Active tasks remaining at shutdown:", remainingTasks);
    await cleanupAllTempFiles();
    await shutdownMemory();
    await flushLogs();
    server?.stop(true);
  }

  return { getAgentClient, initialize, shutdown };
}
