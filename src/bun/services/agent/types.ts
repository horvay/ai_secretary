import type { AgentEventCallback } from "../../state/appState";

export interface AgentQuery {
  query: string;
  context?: {
    screenshot?: string;
    notes?: string[];
  };
}

export interface AgentResponse {
  response: string;
  metadata?: Record<string, unknown>;
}

export interface AgentModelSelection {
  providerID: string;
  modelID: string;
}

export interface AgentClientInstance {
  startServer: () => Promise<void>;
  stopServer: () => Promise<void>;
  stopServerSync: () => void;
  query: (params: AgentQuery, options?: { signal?: AbortSignal; ephemeral?: boolean }) => Promise<AgentResponse>;
  injectContext: (text: string) => Promise<void>;
  checkServer: () => Promise<boolean>;
  getOrCreateSessionId: () => Promise<string>;
  clearSession: () => Promise<string>;
  getSessionMessages: (sessionID?: string, limit?: number) => Promise<unknown[]>;
  getDefaultModel: () => Promise<AgentModelSelection>;
  setSessionModel: (sessionID: string, model: AgentModelSelection) => void;
  getSessionModel: (sessionID: string) => AgentModelSelection | null;
  setThinkingLevel: (variant: string) => void;
  getThinkingLevel: () => string;
  listProviders: () => Promise<unknown>;
  getProviderAuthMethods: () => Promise<unknown>;
  setProviderApiKey: (providerID: string, apiKey: string) => Promise<void>;
  oauthAuthorize: (providerID: string, method: number) => Promise<unknown>;
  oauthCallback: (providerID: string, method: number, code?: string) => Promise<void>;
  getConfig?: () => Promise<unknown>;
  updateConfig?: (config: unknown) => Promise<void>;
  onAgentEvent: (callback: AgentEventCallback) => () => void;
  onProgress: (callback: (message: string) => void) => void;
  getServerStatus: () => boolean;
  isManaged: () => boolean;
  getServerPid: () => number | null;
}

export type AgentBackend = "pi";
