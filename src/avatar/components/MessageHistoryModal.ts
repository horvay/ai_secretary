/**
 * Message History Modal Component
 * Displays a full-screen modal with tabs for message history and routines
 */

import { logDebug, logError, logInfo } from "../utils/logger";

export interface MessageHistoryModalInstance {
  show: () => Promise<void>;
  hide: () => void;
  isVisible: () => boolean;
}

interface Interaction {
  id: number;
  type: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  session_id: string | null;
  metadata: string | null;
}

interface RoutineData {
  id: number;
  name: string;
  description: string | null;
  scheduleType: string;
  scheduleValue: string | null;
  enabled: boolean;
  isDue: boolean;
  isCompleted: boolean;
  isSnoozed: boolean;
  completionsToday: number;
  completionsThisWeek: number;
  snoozedUntilFormatted: string | null;
}

interface ListData {
  id: number;
  name: string;
  description: string | null;
  itemCount: number;
}

interface ListItemData {
  id: number;
  listId: number;
  content: string;
  position: number;
}

interface ReminderData {
  id: number;
  content: string;
  dueAt: number;
  status: "pending" | "triggered" | "completed" | "cancelled" | "failed";
  triggeredAt: number | null;
  deliveredAt: number | null;
  acknowledgedAt: number | null;
  triggerCount: number;
  createdAt: number;
  updatedAt: number;
}

interface AudioTranscriptData {
  id: number;
  source: "microphone" | "speaker";
  content: string;
  timestamp: number;
  started_at: number | null;
  ended_at: number | null;
  app_name: string | null;
  window_title: string | null;
  routed_to_ai: number;
  duration_ms: number | null;
  capture_backend: string | null;
}

interface TaskData {
  id: number;
  title: string;
  description: string | null;
  status: "open" | "completed" | "cancelled";
  priority: "low" | "normal" | "high" | null;
  dueAt: number | null;
  reminderAt: number | null;
  listId: number | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface AgentSessionHistoryMessage {
  id: string;
  role: string;
  timestamp: number | null;
  content: string;
  partCount: number;
}

interface RPCInstance {
  request: {
    getMessagesForDay: (params: { startTime: number; endTime: number }) => Promise<Interaction[]>;
    getAllRoutines: (params: {}) => Promise<{ routines: RoutineData[] }>;
    completeRoutine: (params: { id: number }) => Promise<{ success: boolean; name: string }>;
    uncompleteRoutine: (params: { id: number }) => Promise<{ success: boolean; name: string }>;
    snoozeRoutine: (params: { id: number; duration: string }) => Promise<{ success: boolean; name: string; snoozedUntil: string }>;
    toggleRoutine: (params: { id: number }) => Promise<{ success: boolean; name: string; enabled: boolean }>;
    deleteRoutine: (params: { id: number }) => Promise<{ success: boolean; name: string }>;
    getAllLists: (params: {}) => Promise<{ lists: ListData[] }>;
    getListItems: (params: { listId: number }) => Promise<{ items: ListItemData[] }>;
    removeListItem: (params: { itemId: number }) => Promise<{ success: boolean }>;
    clearList: (params: { listId: number }) => Promise<{ success: boolean; clearedCount: number }>;
    deleteList: (params: { listId: number }) => Promise<{ success: boolean }>;
    getAllTasks: (params: { status?: "open" | "completed" | "cancelled" }) => Promise<{ tasks: TaskData[] }>;
    completeTask: (params: { id: number }) => Promise<{ success: boolean }>;
    cancelTask: (params: { id: number }) => Promise<{ success: boolean }>;
    deleteTask: (params: { id: number }) => Promise<{ success: boolean }>;
    getAllReminders: (params: {}) => Promise<{ reminders: ReminderData[] }>;
    deleteReminder: (params: { id: number }) => Promise<{ success: boolean }>;
    searchAudioTranscripts: (params: { query?: string; source?: "microphone" | "speaker" | "all"; limit?: number }) => Promise<{ results: AudioTranscriptData[] }>;
    agentGetCurrentSessionHistory: (params: {}) => Promise<{
      sessionID: string;
      messageCount: number;
      messages: AgentSessionHistoryMessage[];
    }>;
  };
}

/**
 * Create a MessageHistoryModal instance
 */
export function createMessageHistoryModal(
  elementId: string = "message-history-modal",
  rpc: RPCInstance
): MessageHistoryModalInstance {
  const element = document.getElementById(elementId);
  if (!element) {
    throw new Error(`Message history modal element #${elementId} not found`);
  }

  const messageList = element.querySelector("#message-list") as HTMLElement;
  const routinesList = element.querySelector("#routines-list") as HTMLElement;
  const listsContainer = element.querySelector("#lists-container") as HTMLElement;
  const transcriptsList = element.querySelector("#transcripts-list") as HTMLElement;
  const transcriptSearchInput = element.querySelector("#transcript-search-input") as HTMLInputElement;
  const transcriptSourceFilter = element.querySelector("#transcript-source-filter") as HTMLSelectElement;
  const transcriptRefreshBtn = element.querySelector("#transcript-refresh-btn") as HTMLButtonElement;
  const remindersList = element.querySelector("#reminders-list") as HTMLElement;
  const tasksList = element.querySelector("#tasks-list") as HTMLElement;
  const currentSessionList = element.querySelector("#current-session-list") as HTMLElement;
  const closeButton = element.querySelector(".modal-close") as HTMLElement;
  const tabButtons = element.querySelectorAll(".tab-button") as NodeListOf<HTMLButtonElement>;
  const tabContents = element.querySelectorAll(".tab-content") as NodeListOf<HTMLElement>;

  if (!messageList) {
    throw new Error("Message list element not found");
  }

  if (!routinesList) {
    throw new Error("Routines list element not found");
  }

  if (!listsContainer) {
    throw new Error("Lists container element not found");
  }

  if (!transcriptsList) {
    throw new Error("Transcripts list element not found");
  }

  if (!remindersList) {
    throw new Error("Reminders list element not found");
  }

  if (!tasksList) {
    throw new Error("Tasks list element not found");
  }

  if (!currentSessionList) {
    throw new Error("Current session list element not found");
  }

  let currentTab = "history";

  // Tab switching logic
  tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const tabName = button.dataset.tab;
      if (!tabName) return;

      // Update active tab button
      tabButtons.forEach((btn) => btn.classList.remove("active"));
      button.classList.add("active");

      // Update active tab content
      tabContents.forEach((content) => {
        content.classList.remove("active");
        if (content.id === `tab-${tabName}`) {
          content.classList.add("active");
        }
      });

      currentTab = tabName;

      // Load tab content
      if (tabName === "history") {
        loadMessages();
      } else if (tabName === "routines") {
        loadRoutines();
      } else if (tabName === "lists") {
        loadLists();
      } else if (tabName === "transcripts") {
        loadTranscripts();
      } else if (tabName === "tasks") {
        loadTasks();
      } else if (tabName === "reminders") {
        loadReminders();
      } else if (tabName === "current-session") {
        loadCurrentSessionHistory();
      }
    });
  });

  // Close button handler
  if (closeButton) {
    closeButton.addEventListener("click", () => {
      hide();
    });
  }

  // Close on Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isVisible()) {
      hide();
    }
  });

  // Close on background click (clicking outside the modal wrapper)
  element.addEventListener("click", (e) => {
    const modalWrapper = element.querySelector(".modal-wrapper");
    if (e.target === element || (modalWrapper && !modalWrapper.contains(e.target as Node))) {
      hide();
    }
  });

  /**
   * Format timestamp to readable date/time
   */
  function formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) {
      return "Just now";
    } else if (diffMins < 60) {
      return `${diffMins}m ago`;
    } else if (diffHours < 24) {
      return `${diffHours}h ago`;
    } else if (diffDays === 1) {
      return "Yesterday";
    } else if (diffDays < 7) {
      return `${diffDays}d ago`;
    } else {
      return date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
  }

  /**
   * Render messages in the list
   */
  function renderMessages(messages: Interaction[]): void {
    if (messages.length === 0) {
      messageList.innerHTML = '<div class="message-empty">No messages found for today.</div>';
      return;
    }

    // Sort by timestamp descending (newest first)
    const sortedMessages = [...messages].sort((a, b) => b.timestamp - a.timestamp);

    messageList.innerHTML = sortedMessages
      .map((msg) => {
        // Context messages (overheard speech) have special styling
        const isContext = msg.type === "context";
        const roleClass = isContext ? "context" : msg.role === "user" ? "user" : "assistant";
        const roleLabel = isContext ? "Overheard" : msg.role === "user" ? "You" : "Ari";
        const timestamp = formatTimestamp(msg.timestamp);

        return `
          <div class="message-item ${roleClass}">
            <div class="message-header">
              <span class="message-role">${roleLabel}</span>
              <span class="message-time">${timestamp}</span>
            </div>
            <div class="message-content">${escapeHtml(cleanDisplayContent(msg.content))}</div>
          </div>
        `;
      })
      .join("");
  }

  function getSessionRoleLabel(role: string): string {
    if (role === "user") return "You";
    if (role === "assistant") return "Ari";
    if (role === "system") return "System";
    return role.charAt(0).toUpperCase() + role.slice(1);
  }

  function getSessionRoleClass(role: string): string {
    if (role === "user") return "user";
    if (role === "assistant") return "assistant";
    if (role === "system") return "context";
    return "context";
  }

  function renderCurrentSessionHistory(sessionID: string, messages: AgentSessionHistoryMessage[]): void {
    if (messages.length === 0) {
      currentSessionList.innerHTML = `
        <div class="message-empty">
          No agent messages in current session.<br />
          <span class="current-session-subtle">Session: ${escapeHtml(sessionID)}</span>
        </div>
      `;
      return;
    }

    const sortedMessages = [...messages].sort((a, b) => {
      const ta = a.timestamp ?? 0;
      const tb = b.timestamp ?? 0;
      return ta - tb;
    });

    currentSessionList.innerHTML = sortedMessages
      .map((msg, idx) => {
        const roleClass = getSessionRoleClass(msg.role);
        const roleLabel = getSessionRoleLabel(msg.role);
        const timestamp = typeof msg.timestamp === "number"
          ? formatTimestamp(msg.timestamp)
          : `#${idx + 1}`;
        const content = msg.content.trim().length > 0 ? cleanDisplayContent(msg.content) : "(No textual content)";

        return `
          <div class="message-item ${roleClass}">
            <div class="message-header">
              <span class="message-role">${escapeHtml(roleLabel)}</span>
              <span class="message-time">${escapeHtml(timestamp)} • ${msg.partCount} part${msg.partCount === 1 ? "" : "s"}</span>
            </div>
            <div class="message-content">${escapeHtml(content)}</div>
          </div>
        `;
      })
      .join("");
  }

  function cleanDisplayContent(text: string): string {
    return text
      .replace(/\[(?:anim|state):[^\]]+\]/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  /**
   * Escape HTML to prevent XSS
   */
  function escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Load messages for the history tab
   */
  async function loadMessages(): Promise<void> {
    messageList.innerHTML = '<div class="message-empty">Loading messages...</div>';

    try {
      const now = Date.now();
      const oneDayAgo = now - 24 * 60 * 60 * 1000;

      const messages = await rpc.request.getMessagesForDay({
        startTime: oneDayAgo,
        endTime: now,
      });

      logDebug(`[MessageHistoryModal] Loaded ${messages.length} messages`);
      renderMessages(messages);
    } catch (error) {
      logError("[MessageHistoryModal] Failed to load messages:", error);
      messageList.innerHTML =
        '<div class="message-empty">Failed to load messages. Please try again.</div>';
    }
  }

  /**
   * Load routines for the routines tab
   */
  async function loadRoutines(): Promise<void> {
    routinesList.innerHTML = '<div class="message-empty">Loading routines...</div>';

    try {
      const result = await rpc.request.getAllRoutines({});
      logDebug(`[MessageHistoryModal] Loaded ${result.routines.length} routines`);
      renderRoutines(result.routines);
    } catch (error) {
      logError("[MessageHistoryModal] Failed to load routines:", error);
      routinesList.innerHTML =
        '<div class="message-empty">Failed to load routines. Please try again.</div>';
    }
  }

  /**
   * Load lists for the lists tab
   */
  async function loadLists(): Promise<void> {
    listsContainer.innerHTML = '<div class="message-empty">Loading lists...</div>';

    try {
      const result = await rpc.request.getAllLists({});
      logDebug(`[MessageHistoryModal] Loaded ${result.lists.length} lists`);
      renderLists(result.lists);
    } catch (error) {
      logError("[MessageHistoryModal] Failed to load lists:", error);
      listsContainer.innerHTML =
        '<div class="message-empty">Failed to load lists. Please try again.</div>';
    }
  }

  async function loadTranscripts(): Promise<void> {
    transcriptsList.innerHTML = '<div class="message-empty">Loading transcripts...</div>';
    try {
      const result = await rpc.request.searchAudioTranscripts({
        query: transcriptSearchInput?.value ?? "",
        source: (transcriptSourceFilter?.value as "microphone" | "speaker" | "all") ?? "all",
        limit: 50,
      });
      renderTranscripts(result.results);
    } catch (error) {
      logError("[MessageHistoryModal] Failed to load transcripts:", error);
      transcriptsList.innerHTML = '<div class="message-empty">Failed to load transcripts. Please try again.</div>';
    }
  }

  function renderTranscripts(transcripts: AudioTranscriptData[]): void {
    if (transcripts.length === 0) {
      transcriptsList.innerHTML = `
        <div class="transcripts-empty">
          <p>No transcripts found.</p>
          <span>Microphone entries appear after voice transcription. Speaker entries appear after speaker transcription is enabled.</span>
        </div>
      `;
      return;
    }

    transcriptsList.innerHTML = transcripts
      .map((entry) => {
        const sourceLabel = entry.source === "speaker" ? "Speaker" : "Microphone";
        const sourceClass = entry.source === "speaker" ? "speaker" : "microphone";
        const meta = [formatTimestamp(entry.timestamp), entry.window_title, entry.capture_backend]
          .filter(Boolean)
          .map((part) => escapeHtml(String(part)))
          .join(" • ");
        return `
          <div class="transcript-item ${sourceClass}">
            <div class="transcript-header">
              <span class="transcript-source">${sourceLabel}</span>
              <span class="transcript-time">${meta}</span>
            </div>
            <div class="transcript-content">${escapeHtml(cleanDisplayContent(entry.content))}</div>
          </div>
        `;
      })
      .join("");
  }

  let transcriptSearchTimer: number | null = null;
  transcriptSearchInput?.addEventListener("input", () => {
    if (transcriptSearchTimer !== null) window.clearTimeout(transcriptSearchTimer);
    transcriptSearchTimer = window.setTimeout(() => {
      if (currentTab === "transcripts") void loadTranscripts();
    }, 250);
  });
  transcriptSourceFilter?.addEventListener("change", () => {
    if (currentTab === "transcripts") void loadTranscripts();
  });
  transcriptRefreshBtn?.addEventListener("click", () => void loadTranscripts());

  /**
   * Load tasks for the tasks tab
   */
  async function loadTasks(): Promise<void> {
    tasksList.innerHTML = '<div class="message-empty">Loading tasks...</div>';

    try {
      const result = await rpc.request.getAllTasks({ status: "open" });
      logDebug(`[MessageHistoryModal] Loaded ${result.tasks.length} tasks`);
      renderTasks(result.tasks);
    } catch (error) {
      logError("[MessageHistoryModal] Failed to load tasks:", error);
      tasksList.innerHTML = '<div class="message-empty">Failed to load tasks. Please try again.</div>';
    }
  }

  /**
   * Load reminders for the reminders tab
   */
  async function loadReminders(): Promise<void> {
    remindersList.innerHTML = '<div class="message-empty">Loading reminders...</div>';

    try {
      const result = await rpc.request.getAllReminders({});
      logDebug(`[MessageHistoryModal] Loaded ${result.reminders.length} reminders`);
      renderReminders(result.reminders);
    } catch (error) {
      logError("[MessageHistoryModal] Failed to load reminders:", error);
      remindersList.innerHTML =
        '<div class="message-empty">Failed to load reminders. Please try again.</div>';
    }
  }

  async function loadCurrentSessionHistory(): Promise<void> {
    currentSessionList.innerHTML = '<div class="message-empty">Loading current conversation session...</div>';

    try {
      const result = await rpc.request.agentGetCurrentSessionHistory({});
      logDebug(`[MessageHistoryModal] Loaded ${result.messageCount} current-session messages`);
      renderCurrentSessionHistory(result.sessionID, result.messages);
    } catch (error) {
      logError("[MessageHistoryModal] Failed to load current session history:", error);
      currentSessionList.innerHTML =
        '<div class="message-empty">Failed to load current session. Please try again.</div>';
    }
  }

  /**
   * Get schedule type display string
   */
  function formatSchedule(routine: RoutineData): string {
    switch (routine.scheduleType) {
      case "daily":
        return "Daily";
      case "specific_time":
        return `Daily at ${routine.scheduleValue || "??:??"}`;
      case "weekly_quota":
        return `${routine.scheduleValue || "?"}/week`;
      case "interval":
        return `Every ${routine.scheduleValue || "?"}`;
      default:
        return routine.scheduleType;
    }
  }

  /**
   * Get status class and label for a routine
   */
  function getRoutineStatus(routine: RoutineData): { class: string; label: string } {
    if (!routine.enabled) {
      return { class: "disabled", label: "Disabled" };
    }
    if (routine.isSnoozed) {
      return { class: "snoozed", label: "Snoozed" };
    }
    if (routine.isCompleted) {
      return { class: "completed", label: "Done" };
    }
    if (routine.isDue) {
      return { class: "pending", label: "Due" };
    }
    return { class: "pending", label: "Pending" };
  }

  /**
   * Get progress text based on schedule type
   */
  function getProgressText(routine: RoutineData): string {
    if (routine.scheduleType === "weekly_quota") {
      const quota = routine.scheduleValue ? parseInt(routine.scheduleValue, 10) : 1;
      return `${routine.completionsThisWeek}/${quota} this week`;
    }
    return routine.completionsToday > 0 ? `Done today` : "";
  }

  /**
   * Render routines in the list
   */
  function renderRoutines(routines: RoutineData[]): void {
    if (routines.length === 0) {
      routinesList.innerHTML = `
        <div class="routines-empty">
          <p>No routines yet!</p>
          <div class="routines-hint">
            <p>Ask me to create routines like:</p>
            <p>"Add a daily routine to take vitamins"</p>
            <p>"Remind me to workout 3 times per week"</p>
          </div>
        </div>
      `;
      return;
    }

    routinesList.innerHTML = routines
      .map((routine) => {
        const status = getRoutineStatus(routine);
        const schedule = formatSchedule(routine);
        const progress = getProgressText(routine);

        return `
          <div class="routine-item ${status.class}" data-id="${routine.id}">
            <div class="routine-header">
              <span class="routine-name">${escapeHtml(routine.name)}</span>
              <span class="routine-status ${status.class}">${status.label}</span>
            </div>
            ${routine.description ? `<div class="routine-description">${escapeHtml(routine.description)}</div>` : ""}
            <div class="routine-meta">
              <span class="routine-schedule">📅 ${schedule}</span>
              ${progress ? `<span class="routine-progress">✓ ${progress}</span>` : ""}
              ${routine.isSnoozed && routine.snoozedUntilFormatted ? `<span class="routine-progress">💤 Until ${routine.snoozedUntilFormatted}</span>` : ""}
            </div>
            <div class="routine-actions">
              ${routine.enabled && !routine.isCompleted && !routine.isSnoozed ? `
                <button class="routine-btn complete" data-action="complete" data-id="${routine.id}">✓ Mark Done</button>
                <button class="routine-btn snooze" data-action="snooze" data-id="${routine.id}">💤 Snooze 1h</button>
              ` : ""}
              ${routine.enabled && routine.isCompleted ? `
                <button class="routine-btn uncomplete" data-action="uncomplete" data-id="${routine.id}">↩ Undo</button>
              ` : ""}
              <button class="routine-btn toggle ${routine.enabled ? "enabled" : ""}" data-action="toggle" data-id="${routine.id}">
                ${routine.enabled ? "⏸ Disable" : "▶ Enable"}
              </button>
              <button class="routine-btn delete" data-action="delete" data-id="${routine.id}">🗑️ Delete</button>
            </div>
          </div>
        `;
      })
      .join("");

    // Attach event listeners to buttons
    routinesList.querySelectorAll(".routine-btn").forEach((btn) => {
      btn.addEventListener("click", handleRoutineAction);
    });
  }

  // Track which list is currently expanded
  let expandedListId: number | null = null;

  /**
   * Render lists in the container
   */
  function renderLists(lists: ListData[]): void {
    if (lists.length === 0) {
      listsContainer.innerHTML = `
        <div class="lists-empty">
          <p>No lists yet!</p>
          <div class="lists-hint">
            <p>Ask me to manage lists like:</p>
            <p>"Add milk to my shopping list"</p>
            <p>"Show me my movie list"</p>
            <p>"Remove eggs from the shopping list"</p>
          </div>
        </div>
      `;
      return;
    }

    listsContainer.innerHTML = lists
      .map((list) => {
        const isExpanded = expandedListId === list.id;
        return `
          <div class="list-card ${isExpanded ? "expanded" : ""}" data-list-id="${list.id}">
            <div class="list-header" data-action="toggle" data-list-id="${list.id}">
              <div class="list-info">
                <span class="list-name">📋 ${escapeHtml(list.name)}</span>
                <span class="list-count">${list.itemCount} item${list.itemCount !== 1 ? "s" : ""}</span>
              </div>
              <span class="list-expand-icon">${isExpanded ? "▼" : "▶"}</span>
            </div>
            ${list.description ? `<div class="list-description">${escapeHtml(list.description)}</div>` : ""}
            <div class="list-items-container ${isExpanded ? "" : "hidden"}" id="list-items-${list.id}">
              <div class="list-items-loading">Loading items...</div>
            </div>
            <div class="list-actions ${isExpanded ? "" : "hidden"}">
              <button class="list-btn clear" data-action="clear" data-list-id="${list.id}">🧹 Clear All</button>
              <button class="list-btn delete" data-action="delete" data-list-id="${list.id}">🗑️ Delete List</button>
            </div>
          </div>
        `;
      })
      .join("");

    // Attach event listeners
    listsContainer.querySelectorAll(".list-header").forEach((header) => {
      header.addEventListener("click", handleListToggle);
    });

    listsContainer.querySelectorAll(".list-btn").forEach((btn) => {
      btn.addEventListener("click", handleListAction);
    });

    // If a list was expanded, load its items
    if (expandedListId !== null) {
      loadListItems(expandedListId);
    }
  }

  function renderTasks(tasks: TaskData[]): void {
    if (tasks.length === 0) {
      tasksList.innerHTML = `
        <div class="routines-empty">
          <p>No open tasks yet!</p>
          <div class="routines-hint">
            <p>Ask me things like:</p>
            <p>"Add a task to refactor the memory tools"</p>
            <p>"Create a high priority task to call mom"</p>
          </div>
        </div>
      `;
      return;
    }

    tasksList.innerHTML = tasks
      .map((task) => {
        const due = task.dueAt ? new Date(task.dueAt * 1000).toLocaleString() : null;
        return `
          <div class="routine-item pending" data-id="${task.id}">
            <div class="routine-header">
              <span class="routine-name">${escapeHtml(task.title)}</span>
              <span class="routine-status pending">${task.priority ?? "normal"}</span>
            </div>
            ${task.description ? `<div class="routine-description">${escapeHtml(task.description)}</div>` : ""}
            <div class="routine-meta">
              ${due ? `<span class="routine-schedule">⏰ Due: ${due}</span>` : `<span class="routine-schedule">📝 Open task</span>`}
            </div>
            <div class="routine-actions">
              <button class="routine-btn complete" data-action="complete-task" data-id="${task.id}">✓ Complete</button>
              <button class="routine-btn toggle" data-action="cancel-task" data-id="${task.id}">⛔ Cancel</button>
              <button class="routine-btn delete" data-action="delete-task" data-id="${task.id}">🗑️ Delete</button>
            </div>
          </div>
        `;
      })
      .join("");

    tasksList.querySelectorAll(".routine-btn").forEach((btn) => {
      btn.addEventListener("click", handleTaskAction);
    });
  }

  /**
   * Render reminders in the list
   */
  function renderReminders(reminders: ReminderData[]): void {
    if (reminders.length === 0) {
      remindersList.innerHTML = `
        <div class="routines-empty">
          <p>No reminders yet!</p>
          <div class="routines-hint">
            <p>Ask me to remember things like:</p>
            <p>"Remind me to check the oven in 10 minutes"</p>
            <p>"Remind me to call mom at 3:30pm"</p>
          </div>
        </div>
      `;
      return;
    }

    remindersList.innerHTML = reminders
      .map((reminder) => {
        const statusClass = reminder.status === "pending"
          ? "pending"
          : reminder.status === "completed"
            ? "completed"
            : reminder.status === "triggered"
              ? "snoozed"
              : "disabled";
        const statusLabel = reminder.status.charAt(0).toUpperCase() + reminder.status.slice(1);
        const dueStr = new Date(reminder.dueAt * 1000).toLocaleString();

        return `
          <div class="routine-item ${statusClass}" data-id="${reminder.id}">
            <div class="routine-header">
              <span class="routine-name">${escapeHtml(reminder.content)}</span>
              <span class="routine-status ${statusClass}">${statusLabel}</span>
            </div>
            <div class="routine-meta">
              <span class="routine-schedule">⏰ Due: ${dueStr}</span>
              ${reminder.triggerCount > 0 ? `<span class="routine-progress">🔁 Triggered ${reminder.triggerCount}x</span>` : ""}
            </div>
            <div class="routine-actions">
              <button class="routine-btn delete" data-action="delete-reminder" data-id="${reminder.id}">🗑️ Delete</button>
            </div>
          </div>
        `;
      })
      .join("");

    // Attach event listeners
    remindersList.querySelectorAll(".routine-btn").forEach((btn) => {
      btn.addEventListener("click", handleReminderAction);
    });
  }

  /**
   * Load items for a specific list
   */
  async function loadListItems(listId: number): Promise<void> {
    const container = document.getElementById(`list-items-${listId}`);
    if (!container) return;

    container.innerHTML = '<div class="list-items-loading">Loading items...</div>';

    try {
      const result = await rpc.request.getListItems({ listId });
      renderListItems(container, result.items);
    } catch (error) {
      logError("[MessageHistoryModal] Failed to load list items:", error);
      container.innerHTML = '<div class="list-items-loading">Failed to load items.</div>';
    }
  }

  /**
   * Render items inside a list container
   */
  function renderListItems(container: HTMLElement, items: ListItemData[]): void {
    if (items.length === 0) {
      container.innerHTML = '<div class="list-items-empty">(empty list)</div>';
      return;
    }

    container.innerHTML = items
      .map((item) => `
        <div class="list-item" data-item-id="${item.id}">
          <span class="list-item-content">${escapeHtml(item.content)}</span>
          <button class="list-item-remove" data-action="remove-item" data-item-id="${item.id}" title="Remove">×</button>
        </div>
      `)
      .join("");

    // Attach remove button listeners
    container.querySelectorAll(".list-item-remove").forEach((btn) => {
      btn.addEventListener("click", handleItemRemove);
    });
  }

  /**
   * Handle list header toggle (expand/collapse)
   */
  async function handleListToggle(e: Event): Promise<void> {
    e.stopPropagation(); // Prevent modal from closing
    const header = e.currentTarget as HTMLElement;
    const listId = parseInt(header.dataset.listId || "0", 10);
    if (!listId) return;

    if (expandedListId === listId) {
      // Collapse
      expandedListId = null;
    } else {
      // Expand this list
      expandedListId = listId;
    }

    // Reload lists to update UI
    await loadLists();
  }

  /**
   * Handle list action buttons (clear, delete)
   */
  async function handleListAction(e: Event): Promise<void> {
    e.stopPropagation();
    const button = e.currentTarget as HTMLButtonElement;
    const action = button.dataset.action;
    const listId = parseInt(button.dataset.listId || "0", 10);

    if (!action || !listId) return;

    button.disabled = true;

    try {
      switch (action) {
        case "clear":
          if (confirm("Clear all items from this list?")) {
            await rpc.request.clearList({ listId });
            logInfo(`[Lists] Cleared list ${listId}`);
          }
          break;
        case "delete":
          if (confirm("Delete this entire list?")) {
            await rpc.request.deleteList({ listId });
            expandedListId = null;
            logInfo(`[Lists] Deleted list ${listId}`);
          }
          break;
      }

      // Reload lists to reflect changes
      await loadLists();
    } catch (error) {
      logError(`[Lists] Failed to ${action} list:`, error);
      button.disabled = false;
    }
  }

  /**
   * Handle item remove button
   */
  async function handleItemRemove(e: Event): Promise<void> {
    e.stopPropagation();
    const button = e.currentTarget as HTMLButtonElement;
    const itemId = parseInt(button.dataset.itemId || "0", 10);

    if (!itemId) return;

    button.disabled = true;

    try {
      await rpc.request.removeListItem({ itemId });
      logInfo(`[Lists] Removed item ${itemId}`);

      // Reload lists to reflect changes
      await loadLists();
    } catch (error) {
      logError("[Lists] Failed to remove item:", error);
      button.disabled = false;
    }
  }

  /**
   * Handle routine button clicks
   */
  async function handleRoutineAction(e: Event): Promise<void> {
    const button = e.currentTarget as HTMLButtonElement;
    const action = button.dataset.action;
    const id = parseInt(button.dataset.id || "0", 10);

    if (!action || !id) return;

    button.disabled = true;

    try {
      switch (action) {
        case "complete":
          await rpc.request.completeRoutine({ id });
          logInfo(`[Routines] Completed routine ${id}`);
          break;
        case "uncomplete":
          await rpc.request.uncompleteRoutine({ id });
          logInfo(`[Routines] Undid routine completion ${id}`);
          break;
        case "snooze":
          await rpc.request.snoozeRoutine({ id, duration: "1h" });
          logInfo(`[Routines] Snoozed routine ${id}`);
          break;
        case "toggle":
          await rpc.request.toggleRoutine({ id });
          logInfo(`[Routines] Toggled routine ${id}`);
          break;
        case "delete":
          await rpc.request.deleteRoutine({ id });
          logInfo(`[Routines] Deleted routine ${id}`);
          break;
      }

      // Reload routines to reflect changes
      await loadRoutines();
    } catch (error) {
      logError(`[Routines] Failed to ${action} routine:`, error);
      button.disabled = false;
    }
  }

  /**
   * Handle task button clicks
   */
  async function handleTaskAction(e: Event): Promise<void> {
    const button = e.currentTarget as HTMLButtonElement;
    const action = button.dataset.action;
    const id = parseInt(button.dataset.id || "0", 10);

    if (!action || !id) return;

    button.disabled = true;

    try {
      if (action === "complete-task") {
        await rpc.request.completeTask({ id });
        logInfo(`[Tasks] Completed task ${id}`);
      } else if (action === "cancel-task") {
        await rpc.request.cancelTask({ id });
        logInfo(`[Tasks] Cancelled task ${id}`);
      } else if (action === "delete-task") {
        await rpc.request.deleteTask({ id });
        logInfo(`[Tasks] Deleted task ${id}`);
      }

      await loadTasks();
    } catch (error) {
      logError(`[Tasks] Failed to ${action} task:`, error);
      button.disabled = false;
    }
  }

  /**
   * Handle reminder button clicks
   */
  async function handleReminderAction(e: Event): Promise<void> {
    const button = e.currentTarget as HTMLButtonElement;
    const action = button.dataset.action;
    const id = parseInt(button.dataset.id || "0", 10);

    if (!action || !id) return;

    button.disabled = true;

    try {
      if (action === "delete-reminder") {
        await rpc.request.deleteReminder({ id });
        logInfo(`[Reminders] Deleted reminder ${id}`);
      }

      // Reload reminders to reflect changes
      await loadReminders();
    } catch (error) {
      logError(`[Reminders] Failed to ${action} reminder:`, error);
      button.disabled = false;
    }
  }

  /**
   * Show modal and load current tab content
   */
  async function show(): Promise<void> {
    logDebug("[MessageHistoryModal] Showing modal");
    element.classList.remove("hidden");

    // Load content for the currently active tab
    if (currentTab === "history") {
      await loadMessages();
    } else if (currentTab === "routines") {
      await loadRoutines();
    } else if (currentTab === "lists") {
      await loadLists();
    } else if (currentTab === "tasks") {
      await loadTasks();
    } else if (currentTab === "reminders") {
      await loadReminders();
    } else if (currentTab === "current-session") {
      await loadCurrentSessionHistory();
    }
  }

  /**
   * Hide modal
   */
  function hide(): void {
    logDebug("[MessageHistoryModal] Hiding modal");
    element.classList.add("hidden");
  }

  /**
   * Check if visible
   */
  function isVisible(): boolean {
    return !element.classList.contains("hidden");
  }

  return {
    show,
    hide,
    isVisible,
  };
}

