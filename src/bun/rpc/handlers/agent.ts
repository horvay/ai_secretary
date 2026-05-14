import { logInfo, logWarn } from "../../utils/logger";
import type { AgentClientInstance } from "../../services/agent/types";
import { openUrl } from "../../utils/openUrl";
import { getAppState, setAppState } from "../../services/app-state";

export interface AgentSettingsHandlerDeps {
  getAgentClient: () => Promise<AgentClientInstance>;
}

export function createAgentSettingsHandlers({ getAgentClient }: AgentSettingsHandlerDeps) {
  const summarizePart = (part: Record<string, unknown>): string => {
    const type = typeof part.type === "string" ? part.type : "unknown";
    if (type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
      return part.text;
    }

    if (type === "tool") {
      const name = typeof part.toolName === "string" ? part.toolName : "tool";
      const state = typeof part.state === "string" ? ` (${part.state})` : "";
      return `[Tool: ${name}${state}]`;
    }

    if (type === "thought" && typeof part.text === "string" && part.text.trim().length > 0) {
      return `[Thought] ${part.text}`;
    }

    return `[${type}]`;
  };

  return {
    agentListProviders: async () => {
      const client = await getAgentClient();
      const data = (await client.listProviders()) as any;
      if (!data) {
        return { all: [], default: {}, connected: [] };
      }
      return data;
    },

    agentGetAuthMethods: async () => {
      const client = await getAgentClient();
      const data = (await client.getProviderAuthMethods()) as any;
      return (data ?? {}) as Record<string, Array<{ type: "oauth" | "api"; label: string }>>;
    },

    agentSetApiKey: async ({ providerID, apiKey }: { providerID: string; apiKey: string }) => {
      const client = await getAgentClient();
      await client.setProviderApiKey(providerID, apiKey);
      return { success: true };
    },

    agentStartOAuth: async ({ providerID, methodIndex }: { providerID: string; methodIndex: number }) => {
      const client = await getAgentClient();
      const data = (await client.oauthAuthorize(providerID, methodIndex)) as any;
      const url: string | undefined = data?.url;
      const method: "auto" | "code" | undefined = data?.method;
      const instructions: string | undefined = data?.instructions;

      if (!url || (method !== "auto" && method !== "code")) {
        throw new Error("Agent OAuth authorize did not return a valid url/method");
      }

      openUrl(url);
      return { url, method, instructions };
    },

    agentFinishOAuth: async ({ providerID, methodIndex, code }: { providerID: string; methodIndex: number; code?: string }) => {
      const client = await getAgentClient();
      await client.oauthCallback(providerID, methodIndex, code);
      return { success: true };
    },

    agentGetCurrentSessionId: async () => {
      const client = await getAgentClient();
      const sessionID = await client.getOrCreateSessionId();
      return { sessionID };
    },

    agentClearSession: async () => {
      const client = await getAgentClient();
      const sessionID = await client.clearSession();
      return { success: true, sessionID };
    },

    agentGetCurrentSessionHistory: async () => {
      const client = await getAgentClient();
      const sessionID = await client.getOrCreateSessionId();
      const rawMessages = await client.getSessionMessages(sessionID);
      const messages = rawMessages.map((message, idx) => {
        const info = message.info ?? {};
        const parts = Array.isArray(message.parts) ? message.parts : [];
        const content = parts
          .map((part) => summarizePart(part as Record<string, unknown>))
          .filter((text) => text.length > 0)
          .join("\n\n");

        return {
          id: typeof info.id === "string" ? info.id : `message-${idx}`,
          role: typeof info.role === "string" ? info.role : "unknown",
          timestamp:
            typeof info.time === "object" &&
            info.time !== null &&
            typeof (info.time as Record<string, unknown>).created === "number"
              ? (info.time as Record<string, number>).created
              : null,
          content,
          partCount: parts.length,
        };
      });

      return {
        sessionID,
        messageCount: messages.length,
        messages,
      };
    },

    agentGetSessionModel: async ({ sessionID }: { sessionID?: string }) => {
      const client = await getAgentClient();
      const sid = sessionID ?? (await client.getOrCreateSessionId());
      const model = client.getSessionModel(sid) ?? (await client.getDefaultModel());
      if (model) {
        logInfo(`[RPC] agentGetSessionModel returning: ${model.providerID}/${model.modelID} for session ${sid}`);
      }
      return model ? { sessionID: sid, providerID: model.providerID, modelID: model.modelID } : null;
    },

    agentSetSessionModel: async ({ sessionID, providerID, modelID }: { sessionID?: string; providerID: string; modelID: string }) => {
      const client = await getAgentClient();
      const sid = sessionID ?? (await client.getOrCreateSessionId());
      logWarn(`[RPC] agentSetSessionModel: session=${sid} model=${providerID}/${modelID}`);
      client.setSessionModel(sid, { providerID, modelID });
      setAppState("pi.defaultModel", `${providerID}/${modelID}`);
      return { success: true, sessionID: sid, providerID, modelID };
    },

    agentGetThinkingLevel: async () => {
      const client = await getAgentClient();
      const saved = getAppState("pi.thinkingLevel");
      if (saved) {
        client.setThinkingLevel(saved);
      }
      return { variant: client.getThinkingLevel() };
    },

    agentSetThinkingLevel: async ({ variant }: { variant: string }) => {
      const client = await getAgentClient();
      client.setThinkingLevel(variant);
      setAppState("pi.thinkingLevel", variant);
      return { success: true, variant };
    },
  };
}
