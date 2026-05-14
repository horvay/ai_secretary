/**
 * Shared Application State Module
 * Provides closure-based state management for cross-module communication
 */

// Event types for streaming updates (mirrored from opencode-sdk for decoupling)
export type AgentEventType = "tool_start" | "tool_end" | "processing" | "text_delta" | "thought_delta" | "complete" | "error";

export interface AgentEvent {
  type: AgentEventType;
  toolName?: string;
  message?: string;
  delta?: string;
  thought?: string;
  error?: string;
  /** Stable id for tool calls when available */
  callId?: string;
  // For text_delta events: track part index and full cumulative text
  partIndex?: number;
  fullText?: string;
  // For tool_start/tool_end events: tool arguments/input
  args?: unknown;
  /** For tool_end events: tool result/output */
  result?: unknown;
}

export type AgentEventCallback = (event: AgentEvent) => void;

interface AppStateData {
  idleCallback: AgentEventCallback | null;
}

function createAppState<T extends Record<string, unknown>>(initialState: T) {
  let state = { ...initialState };

  return {
    get: <K extends keyof T>(key: K): T[K] => state[key],
    set: <K extends keyof T>(key: K, value: T[K]): void => {
      state[key] = value;
    },
    getAll: (): Readonly<T> => ({ ...state }),
    reset: (): void => {
      state = { ...initialState };
    },
  };
}

export const appState = createAppState<AppStateData>({
  idleCallback: null,
});



