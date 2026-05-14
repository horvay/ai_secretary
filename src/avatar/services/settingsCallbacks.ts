import type { AvatarInstance } from "../components/avatar/types";
import type { UnifiedSettingsModalInstance } from "../components/UnifiedSettingsModal";
import type { ElectronRpcInstance } from "../types/app-rpc";

export interface SettingsCallbacksDeps {
  unifiedSettingsModal: UnifiedSettingsModalInstance;
  electronRpc: ElectronRpcInstance;
  toast: { show: (message: string, durationMs?: number) => void };
  avatar: AvatarInstance;
  setMuted: (muted: boolean) => void;
  triggerReconcileProfile: () => Promise<void>;
  setBargeInEnabled: (enabled: boolean) => void;
  setBargeInThreshold: (seconds: number) => void;
  logInfo: (...args: unknown[]) => void;
  logError: (...args: unknown[]) => void;
}

export function registerSettingsCallbacks({
  unifiedSettingsModal,
  electronRpc,
  toast,
  avatar,
  setMuted,
  triggerReconcileProfile,
  setBargeInEnabled,
  setBargeInThreshold,
  logInfo,
  logError,
}: SettingsCallbacksDeps): void {
  const micSendToAiCheckbox = document.getElementById("settings-mic-send-to-ai") as HTMLInputElement | null;
  const speakerTranscriptionCheckbox = document.getElementById("settings-speaker-transcription-enabled") as HTMLInputElement | null;

  electronRpc.rpc.request.getMicrophoneSendToAi({})
    .then((result) => {
      if (micSendToAiCheckbox) micSendToAiCheckbox.checked = result.enabled;
    })
    .catch((error) => logError("Failed to load microphone routing setting:", error));

  electronRpc.rpc.request.getSpeakerTranscriptionEnabled({})
    .then((result) => {
      if (speakerTranscriptionCheckbox) speakerTranscriptionCheckbox.checked = result.enabled;
    })
    .catch((error) => logError("Failed to load speaker transcription setting:", error));

  micSendToAiCheckbox?.addEventListener("change", async () => {
    micSendToAiCheckbox.disabled = true;
    try {
      const result = await electronRpc.rpc.request.setMicrophoneSendToAi({ enabled: micSendToAiCheckbox.checked });
      micSendToAiCheckbox.checked = result.enabled;
      toast.show(result.enabled ? "Microphone speech will be sent to Ari" : "Microphone speech will be transcribed only");
    } catch (error) {
      logError("Failed to update microphone routing setting:", error);
      toast.show("Failed to update microphone routing");
      const result = await electronRpc.rpc.request.getMicrophoneSendToAi({});
      micSendToAiCheckbox.checked = result.enabled;
    } finally {
      micSendToAiCheckbox.disabled = false;
    }
  });

  speakerTranscriptionCheckbox?.addEventListener("change", async () => {
    speakerTranscriptionCheckbox.disabled = true;
    try {
      const result = await electronRpc.rpc.request.setSpeakerTranscriptionEnabled({ enabled: speakerTranscriptionCheckbox.checked });
      const persisted = await electronRpc.rpc.request.getSpeakerTranscriptionEnabled({});
      speakerTranscriptionCheckbox.checked = persisted.enabled;
      toast.show(persisted.enabled ? "Speaker transcription saved and enabled" : "Speaker transcription saved and disabled");
      logInfo(`🔊 Speaker transcription setting saved: requested=${result.enabled}, persisted=${persisted.enabled}`);
    } catch (error) {
      logError("Failed to update speaker transcription setting:", error);
      toast.show("Failed to update speaker transcription");
      const result = await electronRpc.rpc.request.getSpeakerTranscriptionEnabled({});
      speakerTranscriptionCheckbox.checked = result.enabled;
    } finally {
      speakerTranscriptionCheckbox.disabled = false;
    }
  });

  unifiedSettingsModal.onReminderIntervalChange(async (intervalMinutes) => {
    try {
      const result = await electronRpc.rpc.request.setReminderInterval({ intervalMinutes });
      if (result.success) {
        toast.show(`Reminder interval set to ${result.intervalMinutes} minutes`);
        logInfo(`⏰ Reminder interval updated to ${result.intervalMinutes} minutes`);
      }
    } catch (error) {
      logError("Failed to set reminder interval:", error);
      toast.show("Failed to update reminder interval");
    }
  });

  unifiedSettingsModal.onThinkingLevelChange(async (variant) => {
    try {
      const result = await electronRpc.rpc.request.agentSetThinkingLevel({ variant });
      if (result.success) {
        toast.show(`Thinking level set to ${variant}`);
        logInfo(`🧠 Thinking level updated to ${variant}`);
      }
    } catch (error) {
      logError("Failed to set thinking level:", error);
      toast.show("Failed to update thinking level");
    }
  });

  unifiedSettingsModal.onAvatarOverrideAllowAiChange(async (allowAi) => {
    try {
      const result = await electronRpc.rpc.request.setAvatarOverrideAllowAi({ allowAi });
      if (result.success) {
        unifiedSettingsModal.updateAvatarOverrideAllowAi(result.allowAi);
        toast.show(result.allowAi ? "AI overrides enabled" : "AI overrides disabled");
      }
    } catch (error) {
      logError("Failed to set AI overrides toggle:", error);
      toast.show("Failed to update AI overrides toggle");
    }
  });

  unifiedSettingsModal.onPlayOverride(async (key) => {
    try {
      await avatar.setOverrideStateKey(key);
    } catch (error) {
      logError("Failed to play override:", error);
      toast.show("Failed to play override (check folder/key)");
    }
  });

  unifiedSettingsModal.onCompanionPackRefresh(async () => {
    return electronRpc.rpc.request.listCompanionPacks({});
  });

  unifiedSettingsModal.onCompanionPackChange(async (packID) => {
    const result = await electronRpc.rpc.request.setActiveCompanionPack({ packID });
    if (result.success) {
      await avatar.reloadSprites();
      unifiedSettingsModal.updateCompanionPack(result.packID);
      toast.show(`Active companion pack set to ${result.packID} (${result.defaultStatus})`);
      logInfo(`[Companion Pack UI] Switched to ${result.packID}, session=${result.sessionID}, defaultStatus=${result.defaultStatus}`);
    }
  });

  // Agent settings callbacks
  unifiedSettingsModal.onAgentRefresh(async () => {
    const providers = await electronRpc.rpc.request.agentListProviders({});
    const authMethods = await electronRpc.rpc.request.agentGetAuthMethods({});
    const { sessionID } = await electronRpc.rpc.request.agentGetCurrentSessionId({});
    const sessionModel = await electronRpc.rpc.request.agentGetSessionModel({ sessionID });
    return {
      providers,
      authMethods,
      sessionID,
      sessionModel,
    };
  });

  unifiedSettingsModal.onAgentSetSessionModel(async (providerID, modelID) => {
    try {
      await electronRpc.rpc.request.agentSetSessionModel({ providerID, modelID });
      logInfo(`[Agent UI] Session model set to ${providerID}/${modelID}`);
    } catch (err) {
      logError("Failed to set agent session model:", err);
      toast.show("Failed to set agent model");
      throw err;
    }
  });

  unifiedSettingsModal.onAgentSetApiKey(async (providerID, apiKey) => {
    try {
      await electronRpc.rpc.request.agentSetApiKey({ providerID, apiKey });
      toast.show(`Saved API key for ${providerID}`);
    } catch (err) {
      logError("Failed to set agent API key:", err);
      toast.show("Failed to save API key");
      throw err;
    }
  });

  unifiedSettingsModal.onAgentOAuthLogin(async (providerID, methodIndex) => {
    const start = await electronRpc.rpc.request.agentStartOAuth({ providerID, methodIndex });
    toast.show(start.instructions ? start.instructions : "Check your browser to complete login…", 5000);

    if (start.method === "auto") {
      await electronRpc.rpc.request.agentFinishOAuth({ providerID, methodIndex });
      toast.show(`✅ Logged in to ${providerID}`);
      return;
    }

    // Fallback: provider requires a code paste
    const code = window.prompt(`Paste the authorization code for ${providerID}:`) ?? "";
    if (!code.trim()) {
      toast.show("OAuth code required but not provided.");
      throw new Error("OAuth code required but not provided");
    }
    await electronRpc.rpc.request.agentFinishOAuth({ providerID, methodIndex, code: code.trim() });
    toast.show(`✅ Logged in to ${providerID}`);
  });

  unifiedSettingsModal.onAgentClearSession(async () => {
    try {
      const result = await electronRpc.rpc.request.agentClearSession({});
      toast.show("Started a new conversation session");
      logInfo(`[Agent UI] Cleared session, now using ${result.sessionID}`);
      return result.sessionID;
    } catch (err) {
      logError("Failed to clear agent session:", err);
      toast.show("Failed to clear conversation session");
      throw err;
    }
  });

  unifiedSettingsModal.onBargeInSettingsChange((settings) => {
    setBargeInEnabled(settings.enabled);
    setBargeInThreshold(settings.thresholdSeconds);
    logInfo(`🎤 Barge-in settings updated: enabled=${settings.enabled}, threshold=${settings.thresholdSeconds}s`);
  });

  unifiedSettingsModal.onMuteChange((muted) => {
    setMuted(muted);

    // Notify backend
    electronRpc.rpc.request.setMuted({ muted }).catch(err => {
      logError("Failed to notify backend of mute state:", err);
    });

    // Update mute button appearance
    const muteButton = document.getElementById("mute-button");
    const muteIcon = muteButton?.querySelector(".mute-icon");
    if (muteButton && muteIcon) {
      if (muted) {
        muteButton.classList.add("muted");
        muteIcon.textContent = "🔇";
        muteButton.title = "Unmute Ari";
      } else {
        muteButton.classList.remove("muted");
        muteIcon.textContent = "🔊";
        muteButton.title = "Mute Ari";
      }
    }
    logInfo(`🔇 Mute ${muted ? "enabled" : "disabled"}`);
  });

  unifiedSettingsModal.onRefreshStats(async () => {
    const stats = await electronRpc.rpc.request.getMemoryStats({});
    return {
      totalInteractions: stats.totalInteractions,
      todayInteractions: stats.todayInteractions,
      screenshots: stats.totalScreenshots,
      summaries: stats.totalDailySummaries,
      hasProfile: stats.profileHasContent,
    };
  });

  unifiedSettingsModal.onMemorySettingsRefresh(async () => {
    return electronRpc.rpc.request.getMemorySettings({});
  });

  unifiedSettingsModal.onMemorySettingsChange(async (settings) => {
    const result = await electronRpc.rpc.request.setMemorySettings(settings);
    unifiedSettingsModal.updateMemorySettings(result);
    toast.show("✅ Memory settings saved");
  });

  unifiedSettingsModal.onLocalModelSettingsRefresh(async () => {
    return electronRpc.rpc.request.getLocalModelSettings({});
  });

  unifiedSettingsModal.onLocalModelSettingsChange(async (settings) => {
    const result = await electronRpc.rpc.request.setLocalModelSettings(settings);
    toast.show("✅ Local model settings saved");
    return {
      reasoning: result.reasoning,
      reasoningBudget: result.reasoningBudget,
      contextSize: result.contextSize,
    };
  });

  unifiedSettingsModal.onPlaywrightSettingsRefresh(async () => {
    return electronRpc.rpc.request.getPlaywrightSettings({});
  });

  unifiedSettingsModal.onPlaywrightEnabledChange(async (enabled) => {
    const result = await electronRpc.rpc.request.setPlaywrightEnabled({ enabled });
    toast.show(enabled ? "✅ Browser automation enabled" : "Browser automation disabled", 5000);
    return result;
  });

  unifiedSettingsModal.onFirecrawlSettingsRefresh(async () => {
    return electronRpc.rpc.request.getFirecrawlSettings({});
  });

  unifiedSettingsModal.onFirecrawlSettingsChange(async (settings) => {
    const result = await electronRpc.rpc.request.setFirecrawlSettings(settings);
    toast.show(result.enabled ? "✅ Firecrawl web search enabled" : "Firecrawl web search disabled", 5000);
    return result;
  });

  unifiedSettingsModal.onTriggerSummary(async () => {
    logInfo("🔧 Debug: Triggering daily summary...");
    const result = await electronRpc.rpc.request.triggerDailySummary({});
    if (result) {
      toast.show("✅ Daily summary triggered!");
    }
  });

  unifiedSettingsModal.onReconcileProfile(async () => {
    logInfo("🔧 Debug: Reconciling profile...");
    await triggerReconcileProfile();
    toast.show("✅ Profile reconciliation started!");
  });

  unifiedSettingsModal.onExportData(async () => {
    logInfo("🔧 Debug: Exporting data...");
    const result = await electronRpc.rpc.request.exportMemory({});
    toast.show(`📦 Exported memory to ${result.path}`, 6000);
  });

  unifiedSettingsModal.onForgetLastTurn(async () => {
    logInfo("🔧 Debug: Forgetting last turn...");
    const result = await electronRpc.rpc.request.forgetLastTurn({});
    toast.show(result.success ? "🧼 Forgot the last turn" : "Nothing to forget right now");
  });

  unifiedSettingsModal.onClearMemory(async () => {
    logInfo("🔧 Debug: Clearing memory...");
    await electronRpc.rpc.request.clearMemorySegment({ segment: "all" });
    toast.show("🗑️ Cleared all memory");
  });

  unifiedSettingsModal.onClose(() => {
    // Just hide, nothing else needed
  });
}
