/**
 * Debug Panel Component
 * Provides testing controls for memory features
 */

import { logDebug, logInfo } from "../utils/logger";

export interface DebugPanelInstance {
  show: () => void;
  hide: () => void;
  isVisible: () => boolean;
  updateStats: (stats: MemoryStats) => void;
}

export interface MemoryStats {
  totalInteractions: number;
  todayInteractions: number;
  totalScreenshots: number;
  totalDailySummaries: number;
  profileHasContent: boolean;
}

interface DebugPanelState {
  visible: boolean;
  gearButton: HTMLElement | null;
  panel: HTMLElement | null;
  onTriggerDailySummary: (() => Promise<void>) | null;
  onReconcileProfile: (() => Promise<void>) | null;
  onClearMemory: (() => Promise<void>) | null;
  onExportData: (() => Promise<void>) | null;
  onRefreshStats: (() => Promise<void>) | null;
}

/**
 * Create a debug panel instance
 */
export function createDebugPanel(options?: {
  onTriggerDailySummary?: () => Promise<void>;
  onReconcileProfile?: () => Promise<void>;
  onClearMemory?: () => Promise<void>;
  onExportData?: () => Promise<void>;
  onRefreshStats?: () => Promise<void>;
}): DebugPanelInstance {
  const state: DebugPanelState = {
    visible: false,
    gearButton: null,
    panel: null,
    onTriggerDailySummary: options?.onTriggerDailySummary ?? null,
    onReconcileProfile: options?.onReconcileProfile ?? null,
    onClearMemory: options?.onClearMemory ?? null,
    onExportData: options?.onExportData ?? null,
    onRefreshStats: options?.onRefreshStats ?? null,
  };

  // Create gear button
  const gearButton = document.createElement("div");
  gearButton.id = "debug-gear-btn";
  gearButton.className = "debug-gear-btn";
  gearButton.innerHTML = "⚙️";
  gearButton.title = "Debug Panel";
  document.body.appendChild(gearButton);
  state.gearButton = gearButton;

  // Create panel
  const panel = document.createElement("div");
  panel.id = "debug-panel";
  panel.className = "debug-panel hidden";
  panel.innerHTML = `
    <div class="debug-panel-content">
      <div class="debug-header">
        <h3>🔧 Memory Debug</h3>
        <button class="debug-close-btn">×</button>
      </div>

      <div class="debug-section">
        <h4>📊 Stats</h4>
        <div class="debug-stats">
          <div class="stat-row">
            <span class="stat-label">Total Interactions</span>
            <span class="stat-value" id="stat-total-interactions">-</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Today's Interactions</span>
            <span class="stat-value" id="stat-today-interactions">-</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Screenshots</span>
            <span class="stat-value" id="stat-screenshots">-</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Daily Summaries</span>
            <span class="stat-value" id="stat-summaries">-</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Profile</span>
            <span class="stat-value" id="stat-profile">-</span>
          </div>
        </div>
        <button class="debug-btn secondary" id="debug-refresh-stats">🔄 Refresh Stats</button>
      </div>

      <div class="debug-section">
        <h4>⚡ Actions</h4>
        <button class="debug-btn primary" id="debug-trigger-summary">📝 Trigger Daily Summary</button>
        <button class="debug-btn primary" id="debug-reconcile-profile">🧠 Reconcile Profile</button>
        <button class="debug-btn secondary" id="debug-export-data">📦 Export Memory Data</button>
        <button class="debug-btn danger" id="debug-clear-memory">🗑️ Clear All Memory</button>
      </div>

      <div class="debug-section">
        <h4>ℹ️ Info</h4>
        <p class="debug-info">Data stored in: <code>AI_SECRETARY_DATA_DIR/memory/</code></p>
      </div>
    </div>
  `;
  document.body.appendChild(panel);
  state.panel = panel;

  // Add event listeners
  gearButton.addEventListener("click", () => {
    if (state.visible) {
      hide();
    } else {
      show();
    }
  });

  const closeBtn = panel.querySelector(".debug-close-btn");
  closeBtn?.addEventListener("click", hide);

  // Action buttons
  const triggerSummaryBtn = panel.querySelector("#debug-trigger-summary");
  triggerSummaryBtn?.addEventListener("click", async () => {
    if (state.onTriggerDailySummary) {
      setButtonLoading(triggerSummaryBtn as HTMLButtonElement, true);
      try {
        await state.onTriggerDailySummary();
      } finally {
        setButtonLoading(triggerSummaryBtn as HTMLButtonElement, false);
      }
    }
  });

  const reconcileProfileBtn = panel.querySelector("#debug-reconcile-profile");
  reconcileProfileBtn?.addEventListener("click", async () => {
    if (state.onReconcileProfile) {
      setButtonLoading(reconcileProfileBtn as HTMLButtonElement, true);
      try {
        await state.onReconcileProfile();
      } finally {
        setButtonLoading(reconcileProfileBtn as HTMLButtonElement, false);
      }
    }
  });

  const exportDataBtn = panel.querySelector("#debug-export-data");
  exportDataBtn?.addEventListener("click", async () => {
    if (state.onExportData) {
      setButtonLoading(exportDataBtn as HTMLButtonElement, true);
      try {
        await state.onExportData();
      } finally {
        setButtonLoading(exportDataBtn as HTMLButtonElement, false);
      }
    }
  });

  const clearMemoryBtn = panel.querySelector("#debug-clear-memory");
  clearMemoryBtn?.addEventListener("click", async () => {
    if (confirm("Are you sure you want to clear ALL memory data? This cannot be undone!")) {
      if (state.onClearMemory) {
        setButtonLoading(clearMemoryBtn as HTMLButtonElement, true);
        try {
          await state.onClearMemory();
        } finally {
          setButtonLoading(clearMemoryBtn as HTMLButtonElement, false);
        }
      }
    }
  });

  const refreshStatsBtn = panel.querySelector("#debug-refresh-stats");
  refreshStatsBtn?.addEventListener("click", async () => {
    if (state.onRefreshStats) {
      setButtonLoading(refreshStatsBtn as HTMLButtonElement, true);
      try {
        await state.onRefreshStats();
      } finally {
        setButtonLoading(refreshStatsBtn as HTMLButtonElement, false);
      }
    }
  });

  // Close on escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.visible) {
      hide();
    }
  });

  // Close on click outside
  panel.addEventListener("click", (e) => {
    if (e.target === panel) {
      hide();
    }
  });

  function show(): void {
    if (state.panel) {
      state.panel.classList.remove("hidden");
      state.visible = true;
      logDebug("[DebugPanel] Shown");

      // Request stats refresh
      if (state.onRefreshStats) {
        state.onRefreshStats();
      }
    }
  }

  function hide(): void {
    if (state.panel) {
      state.panel.classList.add("hidden");
      state.visible = false;
      logDebug("[DebugPanel] Hidden");
    }
  }

  function isVisible(): boolean {
    return state.visible;
  }

  function updateStats(stats: MemoryStats): void {
    const setStatValue = (id: string, value: string | number) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(value);
    };

    setStatValue("stat-total-interactions", stats.totalInteractions);
    setStatValue("stat-today-interactions", stats.todayInteractions);
    setStatValue("stat-screenshots", stats.totalScreenshots);
    setStatValue("stat-summaries", stats.totalDailySummaries);
    setStatValue("stat-profile", stats.profileHasContent ? "✅ Has content" : "⚪ Empty");
  }

  function setButtonLoading(btn: HTMLButtonElement, loading: boolean): void {
    if (loading) {
      btn.disabled = true;
      btn.dataset.originalText = btn.textContent || "";
      btn.textContent = "⏳ Working...";
    } else {
      btn.disabled = false;
      btn.textContent = btn.dataset.originalText || btn.textContent;
    }
  }

  logInfo("[DebugPanel] Created");

  return {
    show,
    hide,
    isVisible,
    updateStats,
  };
}

