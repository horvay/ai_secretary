/**
 * Agent Activity Modal
 * Full-screen, scrollable, detailed view of all agentUpdate events.
 */

import { logDebug, logWarn } from "../utils/logger";

export type AgentActivityEventType =
  | "tool_start"
  | "tool_end"
  | "processing"
  | "text_delta"
  | "thought_delta"
  | "complete"
  | "error";

export interface AgentActivityEvent {
  type: AgentActivityEventType | string;
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
  durationMs?: number;
  timestamp: number;
}

export interface AgentActivityModalInstance {
  addEvent: (event: Omit<AgentActivityEvent, "timestamp">) => void;
  clear: () => void;
  show: () => void;
  hide: () => void;
  isVisible: () => boolean;
}

const MAX_EVENTS = 3000;

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return String(ts);
  }
}

function buildSummaryLine(e: AgentActivityEvent): { meta: string; message: string } {
  const parts: string[] = [];
  parts.push(formatTime(e.timestamp));
  parts.push(String(e.type));
  if (e.toolName) parts.push(e.toolName);
  if (e.callId) parts.push(`callId=${e.callId}`);
  if (typeof e.partIndex === "number") parts.push(`part=${e.partIndex}`);
  if (typeof e.durationMs === "number") parts.push(`${Math.round(e.durationMs)}ms`);
  const meta = parts.join(" · ");

  const msg = e.error || e.message || e.delta || "";
  return { meta, message: msg };
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (_k, v) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v as object)) return "[Circular]";
        seen.add(v as object);
      }
      return v;
    },
    2
  );
}

export function createAgentActivityModal(
  modalId: string = "agent-activity-modal",
  listId: string = "agent-activity-list",
  buttonId: string = "research-button"
): AgentActivityModalInstance {
  const modal = document.getElementById(modalId);
  const list = document.getElementById(listId);
  const button = document.getElementById(buttonId);

  if (!modal) throw new Error(`Agent activity modal #${modalId} not found`);
  if (!list) throw new Error(`Agent activity list #${listId} not found`);
  if (!button) throw new Error(`Agent activity button #${buttonId} not found`);

  const closeButton = modal.querySelector(".modal-close") as HTMLButtonElement | null;
  const clearButton = modal.querySelector("#agent-activity-clear") as HTMLButtonElement | null;
  const copyButton = modal.querySelector("#agent-activity-copy") as HTMLButtonElement | null;
  const wrapper = modal.querySelector(".modal-wrapper") as HTMLElement | null;

  const events: AgentActivityEvent[] = [];
  const toolStartsByCallId = new Map<string, number>();
  let textStreamingStartedAt: number | null = null;
  let lastStreamPartIndex: number | undefined;
  let lastStreamFullText: string | undefined;

  let thoughtStreamingStartedAt: number | null = null;
  let lastThoughtPartIndex: number | undefined;
  let lastThoughtFullText: string | undefined;

  function isVisible(): boolean {
    return !modal.classList.contains("hidden");
  }

  function renderEmpty(): void {
    list.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "agent-activity-empty";
    empty.textContent = "No agent activity yet.";
    list.appendChild(empty);
  }

  function appendEventToDom(e: AgentActivityEvent): void {
    try {
      // If empty placeholder is present, clear it.
      if (list.firstElementChild && list.firstElementChild.classList.contains("agent-activity-empty")) {
        list.innerHTML = "";
      }

      const container = document.createElement("div");
      container.className = `agent-event type-${e.type}`;

      const details = document.createElement("details");
      // All events collapsed by default for a cleaner look
      details.open = false;

      const summary = document.createElement("summary");

      const summaryWrap = document.createElement("div");
      summaryWrap.className = "agent-event-summary";

      const metaRow = document.createElement("div");
      metaRow.className = "agent-event-meta";

      const badge = document.createElement("span");
      badge.className = "agent-event-badge";
      badge.textContent = `${formatTime(e.timestamp)} · ${String(e.type)}${e.toolName ? ` · ${e.toolName}` : ""}${
        typeof e.durationMs === "number" ? ` · ${Math.round(e.durationMs)}ms` : ""
      }`;
      metaRow.appendChild(badge);

      summaryWrap.appendChild(metaRow);

      const msgRow = document.createElement("div");
      msgRow.className = "agent-event-message";
      const summaryLine = buildSummaryLine(e);
      msgRow.textContent = summaryLine.message;
      summaryWrap.appendChild(msgRow);

      summary.appendChild(summaryWrap);
      details.appendChild(summary);

      const contentDiv = document.createElement("div");
      contentDiv.className = "agent-event-content";

      // Thinking section (collapsible)
      if (e.thought || (e.type === "thought_stream_end" && e.fullText)) {
        const thoughtContent = e.thought || e.fullText || "";
        const thoughtDetails = document.createElement("details");
        thoughtDetails.className = "nested-details thought-details";
        const thoughtSummary = document.createElement("summary");
        thoughtSummary.textContent = "Thinking";
        thoughtDetails.appendChild(thoughtSummary);

        const thoughtPre = document.createElement("pre");
        thoughtPre.className = "agent-event-json";
        thoughtPre.textContent = thoughtContent;
        thoughtDetails.appendChild(thoughtPre);
        contentDiv.appendChild(thoughtDetails);
      }

      // Arguments section (collapsible)
      if (e.args) {
        const argsDetails = document.createElement("details");
        argsDetails.className = "nested-details args-details";
        const argsSummary = document.createElement("summary");
        argsSummary.textContent = "Arguments";
        argsDetails.appendChild(argsSummary);

        const argsPre = document.createElement("pre");
        argsPre.className = "agent-event-json";
        argsPre.textContent = safeJsonStringify(e.args);
        argsDetails.appendChild(argsPre);
        contentDiv.appendChild(argsDetails);
      }

      // Output/Result section (collapsible)
      if (e.result) {
        const resultDetails = document.createElement("details");
        resultDetails.className = "nested-details result-details";
        const resultSummary = document.createElement("summary");
        resultSummary.textContent = "Output";
        resultDetails.appendChild(resultSummary);

        const resultPre = document.createElement("pre");
        resultPre.className = "agent-event-json";
        resultPre.textContent = typeof e.result === 'string' ? e.result : safeJsonStringify(e.result);
        resultDetails.appendChild(resultPre);
        contentDiv.appendChild(resultDetails);
      }

      // Raw JSON section (collapsible)
      const rawDetails = document.createElement("details");
      rawDetails.className = "nested-details raw-details";
      const rawSummary = document.createElement("summary");
      rawSummary.textContent = "Raw Data";
      rawDetails.appendChild(rawSummary);

      const pre = document.createElement("pre");
      pre.className = "agent-event-json";
      pre.textContent = safeJsonStringify(e);
      rawDetails.appendChild(pre);
      contentDiv.appendChild(rawDetails);

      details.appendChild(contentDiv);
      container.appendChild(details);

      // PREPEND to show newest on top
      list.prepend(container);
    } catch (err) {
      logWarn("[AgentActivityModal] Error appending event to DOM:", err);
    }
  }

  function rerender(): void {
    if (events.length === 0) {
      renderEmpty();
      return;
    }

    list.innerHTML = "";
    // When re-rendering, append them in order so the last one called appendEventToDom (which prepends)
    // results in newest at top. Actually, better to just iterate events and call appendEventToDom.
    for (const e of events) {
      appendEventToDom(e);
    }
  }

  function show(): void {
    modal.classList.remove("hidden");
    // Ensure we have content rendered
    rerender();
  }

  function hide(): void {
    modal.classList.add("hidden");
  }

  function clear(): void {
    events.length = 0;
    renderEmpty();
    logDebug("[AgentActivityModal] Cleared");
  }

  function copyAll(): void {
    const text = safeJsonStringify(events);
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch (e) {
        logWarn("[AgentActivityModal] Failed to copy to clipboard:", e);
      }
    })();
  }

  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isVisible()) hide();
    else show();
  });

  closeButton?.addEventListener("click", (e) => {
    e.preventDefault();
    hide();
  });

  clearButton?.addEventListener("click", (e) => {
    e.preventDefault();
    clear();
  });

  copyButton?.addEventListener("click", (e) => {
    e.preventDefault();
    copyAll();
  });

  // Close on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isVisible()) {
      hide();
    }
  });

  // Close on background click (outside wrapper)
  modal.addEventListener("click", (e) => {
    if (!wrapper) return;
    if (e.target === modal || !wrapper.contains(e.target as Node)) {
      hide();
    }
  });

  // Start hidden with an empty state
  hide();
  renderEmpty();

  function addEvent(evt: Omit<AgentActivityEvent, "timestamp">): void {
    // Collapse text streaming: show start + end only.
    if (evt.type === "text_delta") {
      const now = Date.now();
      if (textStreamingStartedAt === null) {
        textStreamingStartedAt = now;
        lastStreamPartIndex = evt.partIndex;
        lastStreamFullText = evt.fullText;

        const startEvent: AgentActivityEvent = {
          type: "text_stream_start",
          message: "Text streaming started",
          partIndex: evt.partIndex,
          timestamp: now,
        };
        events.push(startEvent);
        if (isVisible()) appendEventToDom(startEvent);
      } else {
        // Track the latest cumulative text; don't emit per-delta events.
        lastStreamPartIndex = evt.partIndex;
        lastStreamFullText = evt.fullText ?? lastStreamFullText;
      }

      while (events.length > MAX_EVENTS) events.shift();
      return;
    }

    // Collapse thought streaming: show start + end only.
    if (evt.type === "thought_delta") {
      const now = Date.now();
      if (thoughtStreamingStartedAt === null) {
        thoughtStreamingStartedAt = now;
        lastThoughtPartIndex = evt.partIndex;
        lastThoughtFullText = evt.fullText;

        const startEvent: AgentActivityEvent = {
          type: "thought_stream_start",
          message: "Thinking started",
          partIndex: evt.partIndex,
          timestamp: now,
        };
        events.push(startEvent);
        if (isVisible()) appendEventToDom(startEvent);
      } else {
        // Track the latest cumulative thinking text; don't emit per-delta events.
        lastThoughtPartIndex = evt.partIndex;
        lastThoughtFullText = evt.fullText ?? lastThoughtFullText;
      }

      while (events.length > MAX_EVENTS) events.shift();
      return;
    }

    // Tool timing (requires callId to be reliable).
    let durationMs: number | undefined;
    if (evt.type === "tool_start" && evt.callId) {
      toolStartsByCallId.set(evt.callId, Date.now());
    }
    if (evt.type === "tool_end" && evt.callId) {
      const start = toolStartsByCallId.get(evt.callId);
      if (typeof start === "number") {
        durationMs = Date.now() - start;
        toolStartsByCallId.delete(evt.callId);
      }
    }

    // Emit text stream end marker on completion/error.
    if ((evt.type === "complete" || evt.type === "error") && textStreamingStartedAt !== null) {
      const now = Date.now();
      const endEvent: AgentActivityEvent = {
        type: "text_stream_end",
        message: evt.type === "error" ? "Text streaming ended (error)" : "Text streaming ended",
        partIndex: lastStreamPartIndex,
        fullText: lastStreamFullText,
        durationMs: now - textStreamingStartedAt,
        timestamp: now,
      };
      events.push(endEvent);
      if (isVisible()) appendEventToDom(endEvent);

      textStreamingStartedAt = null;
      lastStreamPartIndex = undefined;
      lastStreamFullText = undefined;
    }

    // Emit thought stream end marker on completion/error.
    if ((evt.type === "complete" || evt.type === "error") && thoughtStreamingStartedAt !== null) {
      const now = Date.now();
      const endEvent: AgentActivityEvent = {
        type: "thought_stream_end",
        message: evt.type === "error" ? "Thinking ended (error)" : "Thinking ended",
        partIndex: lastThoughtPartIndex,
        fullText: lastThoughtFullText,
        durationMs: now - thoughtStreamingStartedAt,
        timestamp: now,
      };
      events.push(endEvent);
      if (isVisible()) appendEventToDom(endEvent);

      thoughtStreamingStartedAt = null;
      lastThoughtPartIndex = undefined;
      lastThoughtFullText = undefined;
    }

    const full: AgentActivityEvent = { ...evt, durationMs, timestamp: Date.now() };
    events.push(full);

    // Cap memory
    while (events.length > MAX_EVENTS) events.shift();

    if (isVisible()) {
      // Incremental append for responsiveness
      appendEventToDom(full);
      // NOTE: We don't want to keep scrolled to bottom anymore since newest is at top
      // list.scrollTop = 0; // Or just let the prepend handle it
    }
  }

  return {
    addEvent,
    clear,
    show,
    hide,
    isVisible,
  };
}
