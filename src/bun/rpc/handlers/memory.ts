import { logDebug, logInfo, logWarn, logError } from "../../utils/logger";
import type { AgentClientInstance } from "../../services/agent/types";
import {
  getMemoryStats,
  clearAllMemory,
  clearMemorySegment as clearMemorySegmentService,
  exportMemoryData,
  forgetLastConversationTurn,
  getMemorySettings,
  logInteraction,
  updateMemorySettings,
} from "../../services/memory";
import {
  hasProfileContent,
  getProfileSummary,
} from "../../services/profile";
import { generateDailySummary } from "../../services/daily-summary";
import {
  searchInteractions as searchMemoryIndex,
  findAnswerCandidates,
} from "../../services/memory-index";
import {
  getGBrainPage,
  getGBrainSettings,
  getGBrainStatus,
  searchGBrain,
  updateGBrainSettings,
} from "../../services/gbrain";

export interface MemoryHandlerDeps {
  getAgentClient: () => Promise<AgentClientInstance>;
}

export function createMemoryHandlers({ getAgentClient }: MemoryHandlerDeps) {
  return {
    /**
     * Get memory statistics
     */
    getMemoryStats: async () => {
      try {
        const stats = getMemoryStats();
        const hasContent = await hasProfileContent();
        return {
          ...stats,
          profileHasContent: hasContent,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] getMemoryStats failed:", errorMessage);
        throw error;
      }
    },

    /**
     * Trigger daily summary generation
     */
    triggerDailySummary: async () => {
      try {
        logInfo("[RPC] Triggering daily summary...");
        const result = await generateDailySummary();
        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] triggerDailySummary failed:", errorMessage);
        throw error;
      }
    },

    /**
     * Get user profile summary for display
     */
    getProfileSummary: async () => {
      try {
        const summary = await getProfileSummary();
        return { summary };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] getProfileSummary failed:", errorMessage);
        throw error;
      }
    },

    /**
     * Search memory for past conversations
     */
    searchMemory: async ({ query, limit }: { query: string; limit?: number }) => {
      try {
        logDebug("[RPC] Searching memory for:", query);
        const results = searchMemoryIndex(query, { limit: limit ?? 20 });
        return {
          results: results.map((r) => ({
            content: r.interaction.content,
            role: r.interaction.role,
            timestamp: r.interaction.timestamp,
            sessionId: r.interaction.session_id ?? null,
            turnId: r.interaction.turn_id ?? null,
            snippet: r.snippet,
            relevance: r.relevance,
          })),
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] searchMemory failed:", errorMessage);
        throw error;
      }
    },

    /**
     * Find answer candidates from memory for a question
     */
    findMemoryContext: async ({ question }: { question: string }) => {
      try {
        logDebug("[RPC] Finding memory context for:", question);
        const result = findAnswerCandidates(question, 10);
        return {
          context: result.context,
          sourceCount: result.sources.length,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] findMemoryContext failed:", errorMessage);
        throw error;
      }
    },

    getMemorySettings: async () => {
      try {
        return getMemorySettings();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] getMemorySettings failed:", errorMessage);
        throw error;
      }
    },

    setMemorySettings: async (params: {
      enabled?: boolean;
      conversationLoggingEnabled?: boolean;
      screenshotLoggingEnabled?: boolean;
      ocrEnabled?: boolean;
      retentionDays?: number | null;
      profileLearningEnabled?: boolean;
      redactedTerms?: string[];
    }) => {
      try {
        return updateMemorySettings(params);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] setMemorySettings failed:", errorMessage);
        throw error;
      }
    },

    getGBrainStatus: async () => {
      try {
        return await getGBrainStatus();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] getGBrainStatus failed:", errorMessage);
        throw error;
      }
    },

    getGBrainSettings: async () => {
      try {
        return getGBrainSettings();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] getGBrainSettings failed:", errorMessage);
        throw error;
      }
    },

    setGBrainSettings: async (params: Partial<ReturnType<typeof getGBrainSettings>>) => {
      try {
        return updateGBrainSettings(params);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] setGBrainSettings failed:", errorMessage);
        throw error;
      }
    },

    gbrainSearch: async ({ query, limit }: { query: string; limit?: number }) => {
      try {
        const results = await searchGBrain(query, limit ?? 10);
        return { results };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] gbrainSearch failed:", errorMessage);
        throw error;
      }
    },

    gbrainGetPage: async ({ slug }: { slug: string }) => {
      try {
        const page = await getGBrainPage(slug);
        return { page };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] gbrainGetPage failed:", errorMessage);
        throw error;
      }
    },

    exportMemory: async () => {
      try {
        const path = await exportMemoryData();
        return { path };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] exportMemory failed:", errorMessage);
        throw error;
      }
    },

    clearMemorySegment: async ({ segment }: { segment: "all" | "conversations" | "screenshots" | "summaries" | "profile" | "tasks" | "reminders" | "routines" | "lists" }) => {
      try {
        const clearedCount = await clearMemorySegmentService(segment);
        return { success: true, clearedCount, segment };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] clearMemorySegment failed:", errorMessage);
        throw error;
      }
    },

    forgetLastTurn: async () => {
      try {
        const turnID = await forgetLastConversationTurn();
        return { success: turnID !== null, turnID };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] forgetLastTurn failed:", errorMessage);
        throw error;
      }
    },

    /**
     * Clear all memory data
     */
    clearMemory: async () => {
      try {
        logWarn("[RPC] Clearing all memory data...");
        await clearAllMemory();
        return { success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] clearMemory failed:", errorMessage);
        throw error;
      }
    },

    /**
     * Log an interaction manually (for transcribed voice input)
     */
    logVoiceInteraction: async ({
      content,
      role,
      sessionId,
    }: {
      content: string;
      role: "user" | "assistant";
      sessionId?: string;
    }) => {
      try {
        const id = logInteraction({
          type: "voice",
          role,
          content,
          sessionId,
        });
        return { id };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] logVoiceInteraction failed:", errorMessage);
        throw error;
      }
    },

    /**
     * Inject context into the AI session without triggering a response
     * Used for background speech that Ari should be aware of but not respond to
     */
    injectContext: async ({ text }: { text: string }) => {
      try {
        logDebug("[RPC] Injecting context:", text.substring(0, 50) + "...");
        const client = await getAgentClient();
        await client.injectContext(text);

        // Log to memory - try 'context' type first, fall back to 'text' for older DBs
        try {
          logInteraction({
            type: "context" as any,
            role: "user",
            content: `[Context - overheard]: ${text}`,
          });
        } catch {
          // Fallback for older databases without 'context' type
          logInteraction({
            type: "text",
            role: "user",
            content: `[Context - overheard]: ${text}`,
          });
        }

        return { success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] injectContext failed:", errorMessage);
        // Don't throw - context injection failure shouldn't break the app
        return { success: false };
      }
    },

    /**
     * Get messages for a specific time range (typically one day)
     */
    getMessagesForDay: async ({
      startTime,
      endTime,
    }: {
      startTime: number;
      endTime: number;
    }) => {
      try {
        logDebug(`[RPC] Getting messages from ${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()}`);
        const { getInteractions } = await import("../../services/memory");
        const interactions = getInteractions({
          startTime,
          endTime,
          limit: 1000, // Reasonable limit for a day
        });
        return interactions;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] getMessagesForDay failed:", errorMessage);
        throw error;
      }
    },
  };
}
