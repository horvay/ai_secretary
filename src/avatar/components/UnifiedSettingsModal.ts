/**
 * Unified Settings Modal Component
 * Full-screen modal with tabs for Settings and Debug
 */

import { logDebug, logError, logInfo } from "../utils/logger";

export interface MemoryStats {
  totalInteractions: number;
  todayInteractions: number;
  screenshots: number;
  summaries: number;
  hasProfile: boolean;
}

export interface BargeInSettings {
  enabled: boolean;
  thresholdSeconds: number;
}

export interface MemorySettingsState {
  enabled: boolean;
  conversationLoggingEnabled: boolean;
  screenshotLoggingEnabled: boolean;
  ocrEnabled: boolean;
  retentionDays: number | null;
  profileLearningEnabled: boolean;
  redactedTerms: string[];
}

export interface LocalModelSettingsState {
  reasoning: "on" | "off" | "auto";
  reasoningBudget: number;
  contextSize: number;
}

export interface PlaywrightSettingsState {
  enabled: boolean;
  installed: boolean;
  browsersDir: string;
  executablePath: string | null;
}

export interface FirecrawlSettingsState {
  enabled: boolean;
  hasApiKey: boolean;
}

export interface UnifiedSettingsModalInstance {
  show: (tab?: "settings" | "debug") => Promise<void>;
  hide: () => void;
  isVisible: () => boolean;
  updateReminderInterval: (intervalMinutes: number) => void;
  updateThinkingLevel: (variant: string) => void;
  updateBargeInSettings: (settings: BargeInSettings) => void;
  updateAvatarOverrideAllowAi: (allowAi: boolean) => void;
  updateMuteState: (muted: boolean) => void;
  updateMemorySettings: (settings: MemorySettingsState) => void;
  updateLocalModelSettings: (settings: LocalModelSettingsState) => void;
  updatePlaywrightSettings: (settings: PlaywrightSettingsState) => void;
  updateFirecrawlSettings: (settings: FirecrawlSettingsState) => void;
  updateDebugStats: (stats: MemoryStats) => void;
  updateCompanionPack: (packID: string) => void;
  onReminderIntervalChange: (callback: (intervalMinutes: number) => void) => void;
  onThinkingLevelChange: (callback: (variant: string) => void) => void;
  onBargeInSettingsChange: (callback: (settings: BargeInSettings) => void) => void;
  onAvatarOverrideAllowAiChange: (callback: (allowAi: boolean) => void) => void;
  onMuteChange: (callback: (muted: boolean) => void) => void;
  onPlayOverride: (callback: (key: string) => void | Promise<void>) => void;
  onCompanionPackRefresh: (callback: () => Promise<{ activePackID: string; packs: Array<{ id: string; name: string; version: string; description?: string; source: "env" | "user" | "project" | "builtin" }> }>) => void;
  onCompanionPackChange: (callback: (packID: string) => Promise<void>) => void;
  /** Agent: fetch providers/auth methods + current session/model, then let the modal render dropdowns */
  onAgentRefresh: (callback: () => Promise<{
    providers: {
      all: Array<{ id: string; name: string; models: Record<string, { id: string; name: string }> }>;
      default: Record<string, string>;
      connected: string[];
    };
    authMethods: Record<string, Array<{ type: "oauth" | "api"; label: string }>>;
    sessionID: string;
    sessionModel: { providerID: string; modelID: string } | null;
  }>) => void;
  onAgentSetSessionModel: (callback: (providerID: string, modelID: string) => Promise<void>) => void;
  onAgentSetApiKey: (callback: (providerID: string, apiKey: string) => Promise<void>) => void;
  onAgentOAuthLogin: (callback: (providerID: string, methodIndex: number) => Promise<void>) => void;
  onAgentClearSession: (callback: () => Promise<string>) => void;
  onRefreshStats: (callback: () => Promise<MemoryStats>) => void;
  onTriggerSummary: (callback: () => Promise<void>) => void;
  onReconcileProfile: (callback: () => Promise<void>) => void;
  onMemorySettingsRefresh: (callback: () => Promise<MemorySettingsState>) => void;
  onMemorySettingsChange: (callback: (settings: MemorySettingsState) => Promise<void>) => void;
  onLocalModelSettingsRefresh: (callback: () => Promise<LocalModelSettingsState>) => void;
  onLocalModelSettingsChange: (callback: (settings: LocalModelSettingsState) => Promise<LocalModelSettingsState>) => void;
  onPlaywrightSettingsRefresh: (callback: () => Promise<PlaywrightSettingsState>) => void;
  onPlaywrightEnabledChange: (callback: (enabled: boolean) => Promise<PlaywrightSettingsState>) => void;
  onFirecrawlSettingsRefresh: (callback: () => Promise<FirecrawlSettingsState>) => void;
  onFirecrawlSettingsChange: (callback: (settings: { enabled: boolean; apiKey?: string }) => Promise<FirecrawlSettingsState>) => void;
  onExportData: (callback: () => Promise<void>) => void;
  onForgetLastTurn: (callback: () => Promise<void>) => void;
  onClearMemory: (callback: () => Promise<void>) => void;
  onClose: (callback: () => void) => void;
}

export function createUnifiedSettingsModal(
  elementId: string = "settings-modal"
): UnifiedSettingsModalInstance {
  const element = document.getElementById(elementId);
  if (!element) {
    throw new Error(`Settings modal element #${elementId} not found`);
  }

  // Get all DOM elements
  const closeButton = element.querySelector(".modal-close") as HTMLButtonElement;
  const tabButtons = element.querySelectorAll(".tab-button") as NodeListOf<HTMLButtonElement>;
  const tabContents = element.querySelectorAll(".tab-content") as NodeListOf<HTMLElement>;
  const settingsSectionSelect = element.querySelector("#settings-section-select") as HTMLSelectElement | null;
  const settingsSections = element.querySelectorAll(".settings-section") as NodeListOf<HTMLElement>;

  // Settings tab elements - Custom dropdown
  const reminderDropdown = element.querySelector("#settings-reminder-dropdown") as HTMLDivElement;
  const dropdownToggle = reminderDropdown?.querySelector(".dropdown-toggle") as HTMLButtonElement;
  const dropdownValue = reminderDropdown?.querySelector(".dropdown-value") as HTMLSpanElement;
  const dropdownMenu = reminderDropdown?.querySelector(".dropdown-menu") as HTMLDivElement;
  const dropdownItems = reminderDropdown?.querySelectorAll(".dropdown-item") as NodeListOf<HTMLDivElement>;

  // Thinking level dropdown
  const thinkingDropdown = element.querySelector("#settings-thinking-dropdown") as HTMLDivElement;
  const thinkingToggle = thinkingDropdown?.querySelector(".dropdown-toggle") as HTMLButtonElement;
  const thinkingValue = thinkingDropdown?.querySelector(".dropdown-value") as HTMLSpanElement;
  const thinkingMenu = thinkingDropdown?.querySelector(".dropdown-menu") as HTMLDivElement;
  const thinkingItems = thinkingDropdown?.querySelectorAll(".dropdown-item") as NodeListOf<HTMLDivElement>;

  const memoryEnabledCheckbox = element.querySelector("#settings-memory-enabled") as HTMLInputElement;
  const memoryConversationsCheckbox = element.querySelector("#settings-memory-conversations") as HTMLInputElement;
  const memoryScreenshotsCheckbox = element.querySelector("#settings-memory-screenshots") as HTMLInputElement;
  const memoryOcrCheckbox = element.querySelector("#settings-memory-ocr") as HTMLInputElement;
  const memoryProfileLearningCheckbox = element.querySelector("#settings-memory-profile-learning") as HTMLInputElement;
  const memoryRetentionInput = element.querySelector("#settings-memory-retention") as HTMLInputElement;
  const memoryRedactedTermsInput = element.querySelector("#settings-memory-redacted-terms") as HTMLInputElement;
  const memorySaveBtn = element.querySelector("#settings-memory-save") as HTMLButtonElement;
  const localReasoningEnabledCheckbox = element.querySelector("#settings-local-reasoning-enabled") as HTMLInputElement;
  const localReasoningBudgetInput = element.querySelector("#settings-local-reasoning-budget") as HTMLInputElement;
  const localContextSizeInput = element.querySelector("#settings-local-context-size") as HTMLInputElement;
  const localModelSaveBtn = element.querySelector("#settings-local-model-save") as HTMLButtonElement;

  const companionPackSelect = element.querySelector("#settings-companion-pack") as HTMLSelectElement;
  const companionPackRefreshBtn = element.querySelector("#settings-companion-pack-refresh") as HTMLButtonElement;
  const companionPackStatus = element.querySelector("#settings-companion-pack-status") as HTMLElement;

  // One-shot override elements
  const allowAiOverridesCheckbox = element.querySelector("#settings-allow-ai-overrides") as HTMLInputElement;
  const overrideKeyInput = element.querySelector("#settings-override-key") as HTMLInputElement;
  const playOverrideBtn = element.querySelector("#settings-play-override") as HTMLButtonElement;

  // Agent elements
  const agentGroup = element.querySelector(".settings-agent-group") as HTMLElement | null;
  const agentProviderSelect = element.querySelector("#settings-agent-provider") as HTMLSelectElement;
  const agentModelSelect = element.querySelector("#settings-agent-model") as HTMLSelectElement;
  const agentAuthMethodSelect = element.querySelector("#settings-agent-auth-method") as HTMLSelectElement;
  const agentApiKeyInput = element.querySelector("#settings-agent-api-key") as HTMLInputElement;
  const agentSaveKeyBtn = element.querySelector("#settings-agent-save-key") as HTMLButtonElement;
  const agentOAuthLoginBtn = element.querySelector("#settings-agent-oauth-login") as HTMLButtonElement;
  const agentRefreshBtn = element.querySelector("#settings-agent-refresh") as HTMLButtonElement;
  const agentClearSessionBtn = element.querySelector("#settings-agent-clear-session") as HTMLButtonElement;
  const agentStatus = element.querySelector("#settings-agent-status") as HTMLParagraphElement;
  const playwrightEnabledCheckbox = element.querySelector("#settings-playwright-enabled") as HTMLInputElement;
  const playwrightStatus = element.querySelector("#settings-playwright-status") as HTMLParagraphElement;
  const firecrawlEnabledCheckbox = element.querySelector("#settings-firecrawl-enabled") as HTMLInputElement;
  const firecrawlApiKeyInput = element.querySelector("#settings-firecrawl-api-key") as HTMLInputElement;
  const firecrawlSaveBtn = element.querySelector("#settings-firecrawl-save") as HTMLButtonElement;
  const firecrawlStatus = element.querySelector("#settings-firecrawl-status") as HTMLParagraphElement;

  // Barge-in settings elements
  const bargeInEnabledCheckbox = element.querySelector("#settings-barge-in-enabled") as HTMLInputElement;
  const bargeInThresholdSlider = element.querySelector("#settings-barge-in-threshold") as HTMLInputElement;
  const bargeInThresholdValue = element.querySelector("#barge-in-threshold-value") as HTMLSpanElement;
  const bargeInThresholdRow = element.querySelector("#barge-in-threshold-row") as HTMLDivElement;

  // Mute settings elements
  const muteEnabledCheckbox = element.querySelector("#settings-mute-enabled") as HTMLInputElement;

  // Debug tab elements
  const statTotal = element.querySelector("#debug-stat-total") as HTMLSpanElement;
  const statToday = element.querySelector("#debug-stat-today") as HTMLSpanElement;
  const statScreenshots = element.querySelector("#debug-stat-screenshots") as HTMLSpanElement;
  const statSummaries = element.querySelector("#debug-stat-summaries") as HTMLSpanElement;
  const statProfile = element.querySelector("#debug-stat-profile") as HTMLSpanElement;
  const refreshStatsBtn = element.querySelector("#debug-refresh-stats") as HTMLButtonElement;
  const triggerSummaryBtn = element.querySelector("#debug-trigger-summary") as HTMLButtonElement;
  const reconcileProfileBtn = element.querySelector("#debug-reconcile-profile") as HTMLButtonElement;
  const exportDataBtn = element.querySelector("#debug-export-data") as HTMLButtonElement;
  const forgetLastTurnBtn = element.querySelector("#debug-forget-last-turn") as HTMLButtonElement;
  const clearMemoryBtn = element.querySelector("#debug-clear-memory") as HTMLButtonElement;

  // Callbacks
  let onReminderIntervalChangeCallback: ((intervalMinutes: number) => void) | undefined;
  let onThinkingLevelChangeCallback: ((variant: string) => void) | undefined;
  let onBargeInSettingsChangeCallback: ((settings: BargeInSettings) => void) | undefined;
  let onAvatarOverrideAllowAiChangeCallback: ((allowAi: boolean) => void) | undefined;
  let onPlayOverrideCallback: ((key: string) => void | Promise<void>) | undefined;
  let onMuteChangeCallback: ((muted: boolean) => void) | undefined;
  let onCompanionPackRefreshCallback:
    | (() => Promise<{ activePackID: string; packs: Array<{ id: string; name: string; version: string; description?: string; source: "env" | "user" | "project" | "builtin" }> }>)
    | undefined;
  let onCompanionPackChangeCallback: ((packID: string) => Promise<void>) | undefined;
  let onAgentRefreshCallback:
    | (() => Promise<{
        providers: {
          all: Array<{ id: string; name: string; models: Record<string, { id: string; name: string }> }>;
          default: Record<string, string>;
          connected: string[];
        };
        authMethods: Record<string, Array<{ type: "oauth" | "api"; label: string }>>;
        sessionID: string;
        sessionModel: { providerID: string; modelID: string } | null;
      }>)
    | undefined;
  let onAgentSetSessionModelCallback: ((providerID: string, modelID: string) => Promise<void>) | undefined;
  let onAgentSetApiKeyCallback: ((providerID: string, apiKey: string) => Promise<void>) | undefined;
  let onAgentOAuthLoginCallback: ((providerID: string, methodIndex: number) => Promise<void>) | undefined;
  let onAgentClearSessionCallback: (() => Promise<string>) | undefined;
  let onRefreshStatsCallback: (() => Promise<MemoryStats>) | undefined;
  let onTriggerSummaryCallback: (() => Promise<void>) | undefined;
  let onReconcileProfileCallback: (() => Promise<void>) | undefined;
  let onMemorySettingsRefreshCallback: (() => Promise<MemorySettingsState>) | undefined;
  let onMemorySettingsChangeCallback: ((settings: MemorySettingsState) => Promise<void>) | undefined;
  let onLocalModelSettingsRefreshCallback: (() => Promise<LocalModelSettingsState>) | undefined;
  let onLocalModelSettingsChangeCallback: ((settings: LocalModelSettingsState) => Promise<LocalModelSettingsState>) | undefined;
  let onPlaywrightSettingsRefreshCallback: (() => Promise<PlaywrightSettingsState>) | undefined;
  let onPlaywrightEnabledChangeCallback: ((enabled: boolean) => Promise<PlaywrightSettingsState>) | undefined;
  let onFirecrawlSettingsRefreshCallback: (() => Promise<FirecrawlSettingsState>) | undefined;
  let onFirecrawlSettingsChangeCallback: ((settings: { enabled: boolean; apiKey?: string }) => Promise<FirecrawlSettingsState>) | undefined;
  let onExportDataCallback: (() => Promise<void>) | undefined;
  let onForgetLastTurnCallback: (() => Promise<void>) | undefined;
  let onClearMemoryCallback: (() => Promise<void>) | undefined;
  let onCloseCallback: (() => void) | undefined;

  let currentTab = "settings";
  let currentCompanionPackID = "ari";

  // Barge-in settings state
  let bargeInEnabled = true;
  let bargeInThreshold = 5;

  function switchSettingsSection(sectionName: string): void {
    settingsSections.forEach((section) => {
      section.classList.toggle("active", section.dataset.settingsSection === sectionName);
    });
  }

  settingsSectionSelect?.addEventListener("change", () => {
    switchSettingsSection(settingsSectionSelect.value);
  });

  function collectMemorySettings(): MemorySettingsState {
    return {
      enabled: memoryEnabledCheckbox?.checked ?? true,
      conversationLoggingEnabled: memoryConversationsCheckbox?.checked ?? true,
      screenshotLoggingEnabled: memoryScreenshotsCheckbox?.checked ?? true,
      ocrEnabled: memoryOcrCheckbox?.checked ?? true,
      retentionDays: memoryRetentionInput?.value ? Math.max(1, Number.parseInt(memoryRetentionInput.value, 10) || 1) : null,
      profileLearningEnabled: memoryProfileLearningCheckbox?.checked ?? true,
      redactedTerms: (memoryRedactedTermsInput?.value ?? "")
        .split(",")
        .map((term) => term.trim())
        .filter((term) => term.length > 0),
    };
  }

  function collectLocalModelSettings(): LocalModelSettingsState {
    return {
      reasoning: localReasoningEnabledCheckbox?.checked ? "on" : "off",
      reasoningBudget: Math.max(1, Number.parseInt(localReasoningBudgetInput?.value ?? "500", 10) || 500),
      contextSize: Math.max(4096, Number.parseInt(localContextSizeInput?.value ?? "65536", 10) || 65_536),
    };
  }

  // Agent UI state
  let agentProviders:
    | {
        all: Array<{ id: string; name: string; models: Record<string, { id: string; name: string }> }>;
        default: Record<string, string>;
        connected: string[];
      }
    | null = null;
  let agentAuthMethods: Record<string, Array<{ type: "oauth" | "api"; label: string }>> = {};
  let agentSessionID: string | null = null;

  function setAgentStatus(text: string): void {
    if (agentStatus) agentStatus.textContent = text;
  }

  function setCompanionPackStatus(text: string): void {
    if (companionPackStatus) companionPackStatus.textContent = text;
  }

  function clearSelect(select: HTMLSelectElement | null | undefined): void {
    if (!select) return;
    while (select.options.length > 0) select.remove(0);
  }

  function setSelectValueIfPresent(select: HTMLSelectElement | null | undefined, value: string): void {
    if (!select) return;
    const opt = Array.from(select.options).find((o) => o.value === value);
    if (opt) select.value = value;
  }

  /**
   * Native <select> dropdown popups are unreliable in our Chromium/webview modal stack
   * (z-index/overflow quirks). We wrap selects in the same custom dropdown UI used
   * elsewhere, while keeping the underlying <select> as the source of truth.
   */
  type CustomDropdownForSelect = {
    root: HTMLDivElement;
    toggle: HTMLButtonElement;
    menu: HTMLDivElement;
    valueEl: HTMLSpanElement;
    refresh: () => void;
    setDisabled: (disabled: boolean) => void;
    open: () => void;
    close: () => void;
    isOpen: () => boolean;
  };

  function createCustomDropdownForSelect(
    select: HTMLSelectElement | null | undefined,
    opts?: { placeholder?: string },
  ): CustomDropdownForSelect | null {
    if (!select) return null;
    const parent = select.parentElement;
    if (!parent) return null;

    // If we already wrapped this select (hot reload / multiple init), reuse it.
    const existing = parent.querySelector(
      `#${CSS.escape(select.id)}-custom-dropdown`,
    ) as HTMLDivElement | null;
    if (existing) {
      const toggle = existing.querySelector("button.dropdown-toggle") as HTMLButtonElement | null;
      const menu = existing.querySelector(".dropdown-menu") as HTMLDivElement | null;
      const valueEl = existing.querySelector(".dropdown-value") as HTMLSpanElement | null;
      if (toggle && menu && valueEl) {
        const isOpen = () => !menu.classList.contains("hidden");
        const close = () => {
          menu.classList.add("hidden");
          existing.classList.remove("open");
        };
        const open = () => {
          menu.classList.remove("hidden");
          existing.classList.add("open");
        };
        const refresh = () => {
          // no-op (we don't have a reliable way to rebind here without duplicating listeners)
          // caller should only hit this path in dev/hot situations.
          valueEl.textContent = select.selectedOptions?.[0]?.textContent ?? opts?.placeholder ?? "Select…";
        };
        const setDisabled = (disabled: boolean) => {
          select.disabled = disabled;
          toggle.disabled = disabled;
        };
        return { root: existing, toggle, menu, valueEl, refresh, setDisabled, open, close, isOpen };
      }
    }

    const root = document.createElement("div");
    root.className = "custom-dropdown";
    root.id = `${select.id}-custom-dropdown`;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "dropdown-toggle";
    toggle.id = `${select.id}-dropdown-toggle`;

    const valueEl = document.createElement("span");
    valueEl.className = "dropdown-value";

    const arrow = document.createElement("span");
    arrow.className = "dropdown-arrow";
    arrow.textContent = "▼";

    toggle.appendChild(valueEl);
    toggle.appendChild(arrow);

    const menu = document.createElement("div");
    menu.className = "dropdown-menu hidden";
    menu.id = `${select.id}-dropdown-menu`;

    root.appendChild(toggle);
    root.appendChild(menu);

    // Insert the custom dropdown right before the select, and hide the select.
    parent.insertBefore(root, select);
    select.style.display = "none";

    const isOpen = () => !menu.classList.contains("hidden");
    const close = () => {
      menu.classList.add("hidden");
      root.classList.remove("open");
    };
    const open = () => {
      menu.classList.remove("hidden");
      root.classList.add("open");
    };

    const refresh = () => {
      // Rebuild items from the underlying <select>.
      menu.innerHTML = "";
      const options = Array.from(select.options);
      const selectedValue = select.value;

      if (options.length === 0) {
        const empty = document.createElement("div");
        empty.className = "dropdown-item";
        empty.textContent = "No options available";
        empty.style.cursor = "default";
        empty.style.opacity = "0.75";
        empty.addEventListener("click", (e) => {
          e.stopPropagation();
        });
        menu.appendChild(empty);
      }

      for (const opt of options) {
        const item = document.createElement("div");
        item.className = "dropdown-item";
        item.dataset.value = opt.value;
        item.textContent = opt.textContent ?? opt.value;
        if (opt.value === selectedValue) item.classList.add("selected");

        item.addEventListener("click", (e) => {
          e.stopPropagation();
          select.value = opt.value;
          // Bubble so existing listeners (wired on the hidden select) still fire.
          select.dispatchEvent(new Event("change", { bubbles: true }));
          refresh();
          close();
        });

        menu.appendChild(item);
      }

      valueEl.textContent =
        select.selectedOptions?.[0]?.textContent ??
        options.find((o) => o.value === selectedValue)?.textContent ??
        opts?.placeholder ??
        "Select…";
    };

    const setDisabled = (disabled: boolean) => {
      select.disabled = disabled;
      toggle.disabled = disabled;
    };

    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      if (toggle.disabled) return;
      if (isOpen()) close();
      else open();
    });

    // Close when clicking outside
    document.addEventListener("click", (e) => {
      if (isOpen() && !root.contains(e.target as Node)) close();
    });

    // Keep the label in sync if something changes the select programmatically.
    select.addEventListener("change", () => {
      refresh();
    });

    refresh();
    return { root, toggle, menu, valueEl, refresh, setDisabled, open, close, isOpen };
  }

  // Replace native selects with custom dropdowns (but keep the <select> for state + handlers)
  const agentProviderDropdown = createCustomDropdownForSelect(agentProviderSelect, { placeholder: "Select provider" });
  const agentModelDropdown = createCustomDropdownForSelect(agentModelSelect, { placeholder: "Select model" });
  const agentAuthMethodDropdown = createCustomDropdownForSelect(agentAuthMethodSelect, { placeholder: "Select auth method" });

  function renderAgentProviderOptions(preferProviderID?: string): void {
    if (!agentProviderSelect) return;
    clearSelect(agentProviderSelect);

    const list = agentProviders?.all ?? [];
    const connected = new Set(agentProviders?.connected ?? []);
    const usable = list.filter((provider) => connected.has(provider.id));
    const hasLocal = usable.some((provider) => provider.id === "local-llama");
    const localProvider = { id: "local-llama", name: "Local llama.cpp", models: { local: { id: "local", name: "Local configured model" } } };
    const sorted = [...usable, ...(hasLocal ? [] : [localProvider])].sort((a, b) => a.name.localeCompare(b.name));

    for (const p of sorted) {
      const option = document.createElement("option");
      option.value = p.id;
      option.textContent = p.id === "local-llama" ? p.name : `${p.name} (connected)`;
      agentProviderSelect.appendChild(option);
    }

    const fallbackProviderID =
      (preferProviderID && connected.has(preferProviderID) ? preferProviderID : undefined) ??
      (agentProviders?.default?.opencode && connected.has("opencode") ? "opencode" : undefined) ??
      sorted.find((provider) => provider.id !== "local-llama")?.id ??
      sorted[0]?.id;

    if (fallbackProviderID) {
      setSelectValueIfPresent(agentProviderSelect, fallbackProviderID);
    }

    agentProviderDropdown?.refresh();
  }

  function renderAgentModelOptions(providerID: string, preferModelID?: string): void {
    if (!agentModelSelect) return;
    clearSelect(agentModelSelect);

    const provider = (agentProviders?.all ?? []).find((p) => p.id === providerID);
    const models = providerID === "local-llama" && !provider
      ? { local: { id: "local", name: "Local configured model" } }
      : (provider?.models ?? {});
    const modelList = Object.values(models).sort((a, b) => a.name.localeCompare(b.name));

    for (const m of modelList) {
      const option = document.createElement("option");
      option.value = m.id;
      option.textContent = m.name;
      agentModelSelect.appendChild(option);
    }

    const fallback = preferModelID ?? (agentProviders?.default?.[providerID] ?? modelList[0]?.id);
    if (fallback) {
      setSelectValueIfPresent(agentModelSelect, fallback);
    }

    agentModelDropdown?.refresh();
  }

  function renderAgentAuthMethodOptions(providerID: string): void {
    if (!agentAuthMethodSelect) return;
    clearSelect(agentAuthMethodSelect);

    const methods = providerID === "local-llama" ? [] : (agentAuthMethods[providerID] ?? []);
    for (let i = 0; i < methods.length; i++) {
      const m = methods[i];
      const option = document.createElement("option");
      option.value = String(i);
      option.textContent = `${m.label} (${m.type})`;
      agentAuthMethodSelect.appendChild(option);
    }

    agentAuthMethodDropdown?.refresh();
  }

  function updateAgentProviderMode(providerID: string): void {
    const isLocal = providerID === "local-llama";
    agentGroup?.classList.toggle("local-provider", isLocal);
    agentGroup?.classList.toggle("remote-provider", !isLocal);
  }

  async function refreshAgentUI(): Promise<void> {
    if (!onAgentRefreshCallback) {
      setAgentStatus("Agent not wired (missing onAgentRefresh callback).");
      return;
    }

    try {
      if (agentRefreshBtn) agentRefreshBtn.disabled = true;
      if (agentOAuthLoginBtn) agentOAuthLoginBtn.disabled = true;
      if (agentSaveKeyBtn) agentSaveKeyBtn.disabled = true;
      if (agentClearSessionBtn) agentClearSessionBtn.disabled = true;
      agentProviderDropdown?.setDisabled(true);
      agentModelDropdown?.setDisabled(true);
      agentAuthMethodDropdown?.setDisabled(true);
      setAgentStatus("Refreshing Agent providers/models…");

      const result = await onAgentRefreshCallback();
      agentProviders = result.providers;
      agentAuthMethods = result.authMethods ?? {};
      agentSessionID = result.sessionID;

      const sessionProvider = result.sessionModel?.providerID;
      const sessionModel = result.sessionModel?.modelID;

      renderAgentProviderOptions(sessionProvider);
      const providerID = agentProviderSelect?.value;
      if (providerID) {
        renderAgentModelOptions(providerID, sessionModel);
        renderAgentAuthMethodOptions(providerID);
        updateAgentProviderMode(providerID);
      }

      const hiddenProviderCount = Math.max(0, (agentProviders.all?.length ?? 0) - (agentProviders.connected?.length ?? 0));
      const hiddenNote = hiddenProviderCount > 0 ? ` • ${hiddenProviderCount} unconfigured providers hidden` : "";
      setAgentStatus(
        `Session: ${agentSessionID ?? "unknown"} • Model: ${providerID ?? "?"}/${agentModelSelect?.value ?? "?"}${hiddenNote}`,
      );
    } catch (err) {
      logError("[Settings] Failed to refresh Agent UI:", err);
      setAgentStatus("Failed to load Agent providers/models (check logs).");
    } finally {
      if (agentRefreshBtn) agentRefreshBtn.disabled = false;
      if (agentOAuthLoginBtn) agentOAuthLoginBtn.disabled = false;
      if (agentSaveKeyBtn) agentSaveKeyBtn.disabled = false;
      if (agentClearSessionBtn) agentClearSessionBtn.disabled = false;
      agentProviderDropdown?.setDisabled(false);
      agentModelDropdown?.setDisabled(false);
      agentAuthMethodDropdown?.setDisabled(false);
    }
  }

  async function refreshCompanionPackUI(): Promise<void> {
    if (!onCompanionPackRefreshCallback) {
      setCompanionPackStatus("Companion packs not wired.");
      return;
    }

    try {
      if (companionPackRefreshBtn) companionPackRefreshBtn.disabled = true;
      if (companionPackSelect) companionPackSelect.disabled = true;
      setCompanionPackStatus("Refreshing companion packs…");
      const result = await onCompanionPackRefreshCallback();
      currentCompanionPackID = result.activePackID;
      clearSelect(companionPackSelect);
      for (const pack of result.packs) {
        const option = document.createElement("option");
        option.value = pack.id;
        const sourceLabel = pack.source === "builtin" ? "built-in" : pack.source;
        option.textContent = `${pack.name} (${pack.version}) • ${sourceLabel}`;
        companionPackSelect?.appendChild(option);
      }
      setSelectValueIfPresent(companionPackSelect, currentCompanionPackID);
      setCompanionPackStatus(`Active companion pack: ${currentCompanionPackID}`);
    } catch (err) {
      logError("[Settings] Failed to refresh companion packs:", err);
      setCompanionPackStatus("Failed to load companion packs (check logs).");
    } finally {
      if (companionPackRefreshBtn) companionPackRefreshBtn.disabled = false;
      if (companionPackSelect) companionPackSelect.disabled = false;
    }
  }

  // Tab switching
  tabButtons.forEach((button) => {
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      const tabName = button.dataset.tab;
      if (!tabName) return;

      tabButtons.forEach((btn) => btn.classList.remove("active"));
      button.classList.add("active");

      tabContents.forEach((content) => {
        content.classList.remove("active");
        if (content.id === `tab-${tabName}`) {
          content.classList.add("active");
        }
      });

      currentTab = tabName;

      // Load debug stats when switching to debug tab
      if (tabName === "debug" && onRefreshStatsCallback) {
        refreshStats();
      }
      if (tabName === "settings") {
        void refreshAgentUI();
      }
    });
  });

  // Close button
  closeButton?.addEventListener("click", (e) => {
    e.stopPropagation();
    hide();
  });

  // Close on Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isVisible()) {
      hide();
    }
  });

  // Close on background click - only close when clicking the backdrop (the element itself)
  element.addEventListener("click", (e) => {
    // Only close if clicking directly on the backdrop (the fullscreen-modal element)
    // Not when clicking on any child elements
    if (e.target === element) {
      hide();
    }
  });

  // Custom dropdown handlers
  let currentIntervalValue = 60; // Default 1 hour

  function closeDropdown(): void {
    dropdownMenu?.classList.add("hidden");
    reminderDropdown?.classList.remove("open");
  }

  function openDropdown(): void {
    dropdownMenu?.classList.remove("hidden");
    reminderDropdown?.classList.add("open");
  }

  function isDropdownOpen(): boolean {
    return !dropdownMenu?.classList.contains("hidden");
  }

  function isThinkingDropdownOpen(): boolean {
    return !thinkingMenu?.classList.contains("hidden");
  }

  function closeThinkingDropdown(): void {
    thinkingMenu?.classList.add("hidden");
    thinkingDropdown?.classList.remove("open");
  }

  function openThinkingDropdown(): void {
    thinkingMenu?.classList.remove("hidden");
    thinkingDropdown?.classList.add("open");
  }

  // Toggle dropdown on button click
  dropdownToggle?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isDropdownOpen()) {
      closeDropdown();
    } else {
      openDropdown();
    }
  });

  thinkingToggle?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isThinkingDropdownOpen()) {
      closeThinkingDropdown();
    } else {
      openThinkingDropdown();
    }
  });

  // Handle dropdown item selection
  dropdownItems?.forEach((item) => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      const value = parseInt(item.dataset.value || "60", 10);
      currentIntervalValue = value;

      // Update display text
      if (dropdownValue) {
        dropdownValue.textContent = item.textContent || "1 hour";
      }

      // Update selected state
      dropdownItems.forEach((i) => i.classList.remove("selected"));
      item.classList.add("selected");

      // Close dropdown
      closeDropdown();

      // Trigger callback
      if (onReminderIntervalChangeCallback) {
        onReminderIntervalChangeCallback(value);
      }
    });
  });

  thinkingItems?.forEach((item) => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      const value = item.dataset.value || "minimal";

      // Update display text
      if (thinkingValue) {
        thinkingValue.textContent = value;
      }

      // Update selected state
      thinkingItems.forEach((i) => i.classList.remove("selected"));
      item.classList.add("selected");

      // Close dropdown
      closeThinkingDropdown();

      // Trigger callback
      if (onThinkingLevelChangeCallback) {
        onThinkingLevelChangeCallback(value);
      }
    });
  });

  // Close dropdown when clicking outside
  document.addEventListener("click", (e) => {
    if (isDropdownOpen() && !reminderDropdown?.contains(e.target as Node)) {
      closeDropdown();
    }
    if (isThinkingDropdownOpen() && !thinkingDropdown?.contains(e.target as Node)) {
      closeThinkingDropdown();
    }
  });

  allowAiOverridesCheckbox?.addEventListener("change", (e) => {
    e.stopPropagation();
    onAvatarOverrideAllowAiChangeCallback?.(!!allowAiOverridesCheckbox.checked);
  });

  playOverrideBtn?.addEventListener("click", async (e) => {
    e.stopPropagation();
    const key = (overrideKeyInput?.value ?? "").trim();
    if (!key) return;
    await onPlayOverrideCallback?.(key);
  });

  companionPackRefreshBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    void refreshCompanionPackUI();
  });

  companionPackSelect?.addEventListener("change", async (e) => {
    e.stopPropagation();
    const packID = companionPackSelect.value;
    if (!packID || packID === currentCompanionPackID) return;
    setCompanionPackStatus(`Switching companion pack to ${packID}…`);
    try {
      await onCompanionPackChangeCallback?.(packID);
      currentCompanionPackID = packID;
      setCompanionPackStatus(`Active companion pack: ${packID}`);
    } catch (err) {
      logError("[Settings] Failed to change companion pack:", err);
      setCompanionPackStatus("Failed to change companion pack (check logs).");
      setSelectValueIfPresent(companionPackSelect, currentCompanionPackID);
    }
  });

  // Agent handlers
  agentRefreshBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    void refreshAgentUI();
  });

  agentProviderSelect?.addEventListener("change", async (e) => {
    e.stopPropagation();
    const providerID = agentProviderSelect.value;
    renderAgentModelOptions(providerID);
    renderAgentAuthMethodOptions(providerID);
    updateAgentProviderMode(providerID);
    setAgentStatus(`Session: ${agentSessionID ?? "unknown"} • Model: ${providerID}/${agentModelSelect?.value ?? "?"}`);

    const modelID = agentModelSelect?.value;
    if (providerID && modelID) {
      try {
        await onAgentSetSessionModelCallback?.(providerID, modelID);
      } catch (err) {
        logError("[Settings] Failed to set session model:", err);
      }
    }
  });

  agentModelSelect?.addEventListener("change", async (e) => {
    e.stopPropagation();
    const providerID = agentProviderSelect?.value;
    const modelID = agentModelSelect.value;
    if (!providerID || !modelID) return;
    setAgentStatus(`Session: ${agentSessionID ?? "unknown"} • Model: ${providerID}/${modelID}`);
    try {
      await onAgentSetSessionModelCallback?.(providerID, modelID);
    } catch (err) {
      logError("[Settings] Failed to set session model:", err);
      setAgentStatus("Failed to set model (check logs).");
    }
  });

  agentSaveKeyBtn?.addEventListener("click", async (e) => {
    e.stopPropagation();
    const providerID = agentProviderSelect?.value;
    const apiKey = (agentApiKeyInput?.value ?? "").trim();
    if (!providerID || !apiKey) return;
    setAgentStatus(`Saving API key for ${providerID}…`);
    try {
      await onAgentSetApiKeyCallback?.(providerID, apiKey);
      agentApiKeyInput.value = "";
      setAgentStatus(`Saved API key for ${providerID}.`);
      void refreshAgentUI();
    } catch (err) {
      logError("[Settings] Failed to save API key:", err);
      setAgentStatus("Failed to save API key (check logs).");
    }
  });

  agentOAuthLoginBtn?.addEventListener("click", async (e) => {
    e.stopPropagation();
    const providerID = agentProviderSelect?.value;
    const selected = parseInt(agentAuthMethodSelect?.value ?? "0", 10);
    const method = agentAuthMethods[providerID ?? ""]?.[selected];
    if (!providerID || !method) return;
    if (method.type !== "oauth") {
      setAgentStatus("Selected auth method is not OAuth.");
      return;
    }

    setAgentStatus(`Starting OAuth for ${providerID}… (check your browser)`);
    try {
      await onAgentOAuthLoginCallback?.(providerID, selected);
      setAgentStatus(`OAuth complete for ${providerID}.`);
      void refreshAgentUI();
    } catch (err) {
      logError("[Settings] OAuth login failed:", err);
      setAgentStatus("OAuth login failed (check logs).");
    }
  });

  agentClearSessionBtn?.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!onAgentClearSessionCallback) {
      setAgentStatus("Clear session is not wired.");
      return;
    }

    try {
      agentClearSessionBtn.disabled = true;
      setAgentStatus("Creating a new Agent session...");
      const sessionID = await onAgentClearSessionCallback();
      agentSessionID = sessionID;
      setAgentStatus(`Session reset: ${sessionID}`);
      await refreshAgentUI();
    } catch (err) {
      logError("[Settings] Failed to clear Agent session:", err);
      setAgentStatus("Failed to clear session (check logs).");
    } finally {
      agentClearSessionBtn.disabled = false;
    }
  });

  // Barge-in settings handlers
  function updateBargeInThresholdVisibility(): void {
    if (bargeInThresholdRow) {
      bargeInThresholdRow.style.opacity = bargeInEnabled ? "1" : "0.5";
      bargeInThresholdRow.style.pointerEvents = bargeInEnabled ? "auto" : "none";
    }
  }

  bargeInEnabledCheckbox?.addEventListener("change", () => {
    bargeInEnabled = bargeInEnabledCheckbox.checked;
    updateBargeInThresholdVisibility();
    onBargeInSettingsChangeCallback?.({ enabled: bargeInEnabled, thresholdSeconds: bargeInThreshold });
    logDebug(`[Settings] Barge-in enabled: ${bargeInEnabled}`);
  });

  bargeInThresholdSlider?.addEventListener("input", () => {
    bargeInThreshold = parseInt(bargeInThresholdSlider.value, 10);
    if (bargeInThresholdValue) {
      bargeInThresholdValue.textContent = `${bargeInThreshold}s`;
    }
  });

  bargeInThresholdSlider?.addEventListener("change", () => {
    bargeInThreshold = parseInt(bargeInThresholdSlider.value, 10);
    onBargeInSettingsChangeCallback?.({ enabled: bargeInEnabled, thresholdSeconds: bargeInThreshold });
    logDebug(`[Settings] Barge-in threshold: ${bargeInThreshold}s`);
  });

  memorySaveBtn?.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!onMemorySettingsChangeCallback) return;
    memorySaveBtn.disabled = true;
    memorySaveBtn.textContent = "⏳ Saving...";
    try {
      await onMemorySettingsChangeCallback(collectMemorySettings());
    } finally {
      memorySaveBtn.disabled = false;
      memorySaveBtn.textContent = "💾 Save memory settings";
    }
  });

  localModelSaveBtn?.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!onLocalModelSettingsChangeCallback) return;
    localModelSaveBtn.disabled = true;
    localModelSaveBtn.textContent = "⏳ Saving...";
    try {
      const settings = await onLocalModelSettingsChangeCallback(collectLocalModelSettings());
      updateLocalModelSettings(settings);
    } finally {
      localModelSaveBtn.disabled = false;
      localModelSaveBtn.textContent = "💾 Save local model settings";
    }
  });

  playwrightEnabledCheckbox?.addEventListener("change", async () => {
    if (!onPlaywrightEnabledChangeCallback) return;
    const enabled = playwrightEnabledCheckbox.checked;
    if (enabled) {
      const ok = window.confirm("Ari will download a managed Playwright Chromium binary for your platform and store it locally. Continue?");
      if (!ok) {
        playwrightEnabledCheckbox.checked = false;
        return;
      }
    }

    playwrightEnabledCheckbox.disabled = true;
    if (playwrightStatus) playwrightStatus.textContent = enabled ? "Downloading Chromium for browser automation…" : "Disabling browser automation…";
    try {
      const settings = await onPlaywrightEnabledChangeCallback(enabled);
      updatePlaywrightSettings(settings);
    } catch (error) {
      logError("Failed to update Playwright browser automation setting:", error);
      const settings = await onPlaywrightSettingsRefreshCallback?.();
      if (settings) updatePlaywrightSettings(settings);
    } finally {
      playwrightEnabledCheckbox.disabled = false;
    }
  });

  firecrawlSaveBtn?.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!onFirecrawlSettingsChangeCallback) return;
    firecrawlSaveBtn.disabled = true;
    firecrawlSaveBtn.textContent = "⏳ Saving...";
    try {
      const settings = await onFirecrawlSettingsChangeCallback({
        enabled: firecrawlEnabledCheckbox?.checked ?? false,
        apiKey: firecrawlApiKeyInput?.value,
      });
      updateFirecrawlSettings(settings);
      if (firecrawlApiKeyInput) firecrawlApiKeyInput.value = "";
    } catch (error) {
      logError("Failed to update Firecrawl settings:", error);
      const settings = await onFirecrawlSettingsRefreshCallback?.();
      if (settings) updateFirecrawlSettings(settings);
    } finally {
      firecrawlSaveBtn.disabled = false;
      firecrawlSaveBtn.textContent = "💾 Save Firecrawl settings";
    }
  });

  firecrawlEnabledCheckbox?.addEventListener("change", async () => {
    if (!onFirecrawlSettingsChangeCallback) return;
    const enabled = firecrawlEnabledCheckbox.checked;
    if (enabled) {
      const ok = window.confirm("Enable Firecrawl web search tools for Ari? You must save a Firecrawl API key for searches to work.");
      if (!ok) {
        firecrawlEnabledCheckbox.checked = false;
        return;
      }
    }
    try {
      const settings = await onFirecrawlSettingsChangeCallback({ enabled });
      updateFirecrawlSettings(settings);
    } catch (error) {
      logError("Failed to update Firecrawl enabled setting:", error);
      const settings = await onFirecrawlSettingsRefreshCallback?.();
      if (settings) updateFirecrawlSettings(settings);
    }
  });

  // Mute settings handlers
  muteEnabledCheckbox?.addEventListener("change", () => {
    const muted = muteEnabledCheckbox.checked;
    onMuteChangeCallback?.(muted);
    logDebug(`[Settings] Mute enabled: ${muted}`);
  });

  // Debug handlers
  refreshStatsBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    refreshStats();
  });

  triggerSummaryBtn?.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (onTriggerSummaryCallback) {
      triggerSummaryBtn.disabled = true;
      triggerSummaryBtn.textContent = "⏳ Processing...";
      try {
        await onTriggerSummaryCallback();
      } finally {
        triggerSummaryBtn.disabled = false;
        triggerSummaryBtn.textContent = "📝 Trigger Daily Summary";
      }
    }
  });

  reconcileProfileBtn?.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (onReconcileProfileCallback) {
      reconcileProfileBtn.disabled = true;
      reconcileProfileBtn.textContent = "⏳ Processing...";
      try {
        await onReconcileProfileCallback();
      } finally {
        reconcileProfileBtn.disabled = false;
        reconcileProfileBtn.textContent = "🧠 Reconcile Profile";
      }
    }
  });

  exportDataBtn?.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!onExportDataCallback) return;
    exportDataBtn.disabled = true;
    try {
      await onExportDataCallback();
    } finally {
      exportDataBtn.disabled = false;
    }
  });

  forgetLastTurnBtn?.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!onForgetLastTurnCallback) return;
    forgetLastTurnBtn.disabled = true;
    try {
      await onForgetLastTurnCallback();
    } finally {
      forgetLastTurnBtn.disabled = false;
    }
  });

  clearMemoryBtn?.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!onClearMemoryCallback) return;
    if (confirm("Are you sure you want to clear all memory? This cannot be undone.")) {
      clearMemoryBtn.disabled = true;
      try {
        await onClearMemoryCallback();
      } finally {
        clearMemoryBtn.disabled = false;
      }
    }
  });

  async function refreshStats(): Promise<void> {
    if (!onRefreshStatsCallback) return;

    refreshStatsBtn.disabled = true;
    try {
      const stats = await onRefreshStatsCallback();
      updateDebugStats(stats);
    } catch (error) {
      logError("Failed to refresh stats:", error);
    } finally {
      refreshStatsBtn.disabled = false;
    }
  }

  async function show(tab: "settings" | "debug" = "settings"): Promise<void> {
    // Switch to requested tab
    tabButtons.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    tabContents.forEach((content) => {
      content.classList.toggle("active", content.id === `tab-${tab}`);
    });
    currentTab = tab;

    element.classList.remove("hidden");
    document.body.classList.add("settings-modal-open");
    logDebug(`[UnifiedSettingsModal] Showing modal (tab: ${tab})`);

    // Load debug stats if on debug tab
    if (tab === "debug" && onRefreshStatsCallback) {
      await refreshStats();
    }
    if (tab === "settings") {
      await Promise.allSettled([
        refreshCompanionPackUI(),
        refreshAgentUI(),
        onMemorySettingsRefreshCallback?.().then((settings) => updateMemorySettings(settings)),
        onLocalModelSettingsRefreshCallback?.().then((settings) => updateLocalModelSettings(settings)),
        onPlaywrightSettingsRefreshCallback?.().then((settings) => updatePlaywrightSettings(settings)),
        onFirecrawlSettingsRefreshCallback?.().then((settings) => updateFirecrawlSettings(settings)),
      ]);
    }

    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }

  function hide(): void {
    element.classList.add("hidden");
    document.body.classList.remove("settings-modal-open");
    onCloseCallback?.();
    logDebug("[UnifiedSettingsModal] Modal hidden");
  }

  function isVisible(): boolean {
    return !element.classList.contains("hidden");
  }

  function updateReminderInterval(intervalMinutes: number): void {
    if (!dropdownItems || !dropdownValue) return;

    currentIntervalValue = intervalMinutes;

    // Find matching item and update display
    dropdownItems.forEach((item) => {
      const itemValue = parseInt(item.dataset.value || "0", 10);
      if (itemValue === intervalMinutes) {
        item.classList.add("selected");
        if (dropdownValue) {
          dropdownValue.textContent = item.textContent || "1 hour";
        }
      } else {
        item.classList.remove("selected");
      }
    });
  }

  function updateThinkingLevel(variant: string): void {
    if (!thinkingItems || !thinkingValue) return;

    // Find matching item and update display
    thinkingItems.forEach((item) => {
      const itemValue = item.dataset.value || "minimal";
      if (itemValue === variant) {
        item.classList.add("selected");
        if (thinkingValue) {
          thinkingValue.textContent = variant;
        }
      } else {
        item.classList.remove("selected");
      }
    });
  }

  function updateBargeInSettings(settings: BargeInSettings): void {
    bargeInEnabled = settings.enabled;
    bargeInThreshold = settings.thresholdSeconds;

    if (bargeInEnabledCheckbox) {
      bargeInEnabledCheckbox.checked = bargeInEnabled;
    }
    if (bargeInThresholdSlider) {
      bargeInThresholdSlider.value = String(bargeInThreshold);
    }
    if (bargeInThresholdValue) {
      bargeInThresholdValue.textContent = `${bargeInThreshold}s`;
    }
    updateBargeInThresholdVisibility();
  }

  function updateAvatarOverrideAllowAi(allowAi: boolean): void {
    if (allowAiOverridesCheckbox) {
      allowAiOverridesCheckbox.checked = !!allowAi;
    }
  }

  function updateMuteState(muted: boolean): void {
    if (muteEnabledCheckbox) {
      muteEnabledCheckbox.checked = muted;
    }
  }

  function updateMemorySettings(settings: MemorySettingsState): void {
    if (memoryEnabledCheckbox) memoryEnabledCheckbox.checked = settings.enabled;
    if (memoryConversationsCheckbox) memoryConversationsCheckbox.checked = settings.conversationLoggingEnabled;
    if (memoryScreenshotsCheckbox) memoryScreenshotsCheckbox.checked = settings.screenshotLoggingEnabled;
    if (memoryOcrCheckbox) memoryOcrCheckbox.checked = settings.ocrEnabled;
    if (memoryProfileLearningCheckbox) memoryProfileLearningCheckbox.checked = settings.profileLearningEnabled;
    if (memoryRetentionInput) memoryRetentionInput.value = settings.retentionDays ? String(settings.retentionDays) : "";
    if (memoryRedactedTermsInput) memoryRedactedTermsInput.value = settings.redactedTerms.join(", ");
  }

  function updateLocalModelSettings(settings: LocalModelSettingsState): void {
    if (localReasoningEnabledCheckbox) localReasoningEnabledCheckbox.checked = settings.reasoning !== "off";
    if (localReasoningBudgetInput) localReasoningBudgetInput.value = String(settings.reasoningBudget);
    if (localContextSizeInput) localContextSizeInput.value = String(settings.contextSize);
  }

  function updatePlaywrightSettings(settings: PlaywrightSettingsState): void {
    if (playwrightEnabledCheckbox) playwrightEnabledCheckbox.checked = settings.enabled;
    if (playwrightStatus) {
      if (!settings.enabled) playwrightStatus.textContent = `Browser automation is off. Chromium will be stored in ${settings.browsersDir}`;
      else if (settings.installed && settings.executablePath) playwrightStatus.textContent = `Browser automation is on. Chromium: ${settings.executablePath}`;
      else playwrightStatus.textContent = `Browser automation is on, but Chromium is not installed yet. Storage: ${settings.browsersDir}`;
    }
  }

  function updateFirecrawlSettings(settings: FirecrawlSettingsState): void {
    if (firecrawlEnabledCheckbox) firecrawlEnabledCheckbox.checked = settings.enabled;
    if (firecrawlStatus) {
      if (!settings.enabled) firecrawlStatus.textContent = settings.hasApiKey ? "Web search is off. Firecrawl API key is saved." : "Web search is off. No Firecrawl API key saved.";
      else if (settings.hasApiKey) firecrawlStatus.textContent = "Web search is on. Firecrawl API key is saved.";
      else firecrawlStatus.textContent = "Web search is on, but no Firecrawl API key is saved yet.";
    }
  }

  function updateCompanionPack(packID: string): void {
    currentCompanionPackID = packID;
    setSelectValueIfPresent(companionPackSelect, packID);
    setCompanionPackStatus(`Active companion pack: ${packID}`);
  }

  function updateDebugStats(stats: MemoryStats): void {
    if (statTotal) statTotal.textContent = String(stats.totalInteractions);
    if (statToday) statToday.textContent = String(stats.todayInteractions);
    if (statScreenshots) statScreenshots.textContent = String(stats.screenshots);
    if (statSummaries) statSummaries.textContent = String(stats.summaries);
    if (statProfile) statProfile.textContent = stats.hasProfile ? "Yes ✓" : "Not created";
  }

  return {
    show,
    hide,
    isVisible,
    updateReminderInterval,
    updateThinkingLevel,
    updateBargeInSettings,
    updateAvatarOverrideAllowAi,
    updateMuteState,
    updateMemorySettings,
    updateLocalModelSettings,
    updatePlaywrightSettings,
    updateFirecrawlSettings,
    updateDebugStats,
    updateCompanionPack,
    onReminderIntervalChange: (cb) => { onReminderIntervalChangeCallback = cb; },
    onThinkingLevelChange: (cb) => { onThinkingLevelChangeCallback = cb; },
    onBargeInSettingsChange: (cb) => { onBargeInSettingsChangeCallback = cb; },
    onAvatarOverrideAllowAiChange: (cb) => { onAvatarOverrideAllowAiChangeCallback = cb; },
    onMuteChange: (cb) => { onMuteChangeCallback = cb; },
    onPlayOverride: (cb) => { onPlayOverrideCallback = cb; },
    onCompanionPackRefresh: (cb) => { onCompanionPackRefreshCallback = cb; },
    onCompanionPackChange: (cb) => { onCompanionPackChangeCallback = cb; },
    onAgentRefresh: (cb) => { onAgentRefreshCallback = cb; },
    onAgentSetSessionModel: (cb) => { onAgentSetSessionModelCallback = cb; },
    onAgentSetApiKey: (cb) => { onAgentSetApiKeyCallback = cb; },
    onAgentOAuthLogin: (cb) => { onAgentOAuthLoginCallback = cb; },
    onAgentClearSession: (cb) => { onAgentClearSessionCallback = cb; },
    onRefreshStats: (cb) => { onRefreshStatsCallback = cb; },
    onTriggerSummary: (cb) => { onTriggerSummaryCallback = cb; },
    onReconcileProfile: (cb) => { onReconcileProfileCallback = cb; },
    onMemorySettingsRefresh: (cb) => { onMemorySettingsRefreshCallback = cb; },
    onMemorySettingsChange: (cb) => { onMemorySettingsChangeCallback = cb; },
    onLocalModelSettingsRefresh: (cb) => { onLocalModelSettingsRefreshCallback = cb; },
    onLocalModelSettingsChange: (cb) => { onLocalModelSettingsChangeCallback = cb; },
    onPlaywrightSettingsRefresh: (cb) => { onPlaywrightSettingsRefreshCallback = cb; },
    onPlaywrightEnabledChange: (cb) => { onPlaywrightEnabledChangeCallback = cb; },
    onFirecrawlSettingsRefresh: (cb) => { onFirecrawlSettingsRefreshCallback = cb; },
    onFirecrawlSettingsChange: (cb) => { onFirecrawlSettingsChangeCallback = cb; },
    onExportData: (cb) => { onExportDataCallback = cb; },
    onForgetLastTurn: (cb) => { onForgetLastTurnCallback = cb; },
    onClearMemory: (cb) => { onClearMemoryCallback = cb; },
    onClose: (cb) => { onCloseCallback = cb; },
  };
}

