type RequestSpec = { params: unknown; response: unknown };
type RequestHandlers<T> = {
  [K in keyof T]: T[K] extends RequestSpec ? (params: T[K]["params"]) => Promise<T[K]["response"]> : never;
};
type MessageHandlers<T> = {
  [K in keyof T]: T[K] extends Record<string, unknown> ? (payload: T[K]) => void : never;
};
type RPCSchema<T extends { requests?: Record<string, RequestSpec>; messages?: Record<string, Record<string, unknown>> }> = {
  requests: T["requests"] extends Record<string, RequestSpec> ? RequestHandlers<T["requests"]> : {};
  messages: T["messages"] extends Record<string, Record<string, unknown>> ? MessageHandlers<T["messages"]> : {};
};

export type AISecretaryRPC = {
  bun: RPCSchema<{
    requests: {
      // AI Interaction
      askQuestion: {
        params: {
          question: string;
          includeScreenshot?: boolean;
          activeWindowOnly?: boolean;
          source?: "text" | "voice" | "routine" | "reminder" | "system";
          showUserQuestion?: boolean;
          historyLabel?: string;
          voiceMode?: "normal" | "ari-decides";
        };
        response: {
          response: string;
          delivered: boolean;
          visibleText: boolean;
          audible: boolean;
          audioData?: string; // base64 encoded audio
        };
      };

      // Avatar State Control
      setAvatarState: {
        params: {
          state: "idle" | "thinking" | "talking";
        };
        response: void;
      };

      // Screenshot
      captureScreenshot: {
        params: {
          activeWindowOnly?: boolean;
        };
        response: {
          image: string; // base64 encoded
        };
      };

      // TTS
      speakText: {
        params: {
          text: string;
          volume?: number; // 0.0 to 1.0
        };
        response: {
          audioData: string; // base64 encoded
          duration: number; // in seconds
          sampleRate?: number;
        };
      };

      /** Webview signals that the Electron preload bridge is ready */
      webviewReady: {
        params: {};
        response: void;
      };

      cancelTTS: {
        params: {};
        response: void;
      };

      /** Interrupt the current response - stops TTS, cancels AI generation, returns to idle */
      interruptResponse: {
        params: {};
        response: {
          interrupted: boolean;
        };
      };

      // Sprite Management (WebM video)
      getSpriteInfo: {
        params: {};
        response: {
          source: "pack";
          path: string;
          hasSprites: boolean;
          statuses: string[];
          types: Array<"idle" | "processing" | "talking">;
          folders: Record<string, Record<"idle" | "processing" | "talking", string[]>>;
        };
      };

      /**
       * Load an animated sprite (WebM video).
       * Returns raw video bytes for frontend to decode with <video> element.
       */
      loadAnimatedSprite: {
        params: {
          status: string;
          type: "idle" | "processing" | "talking";
          folder: string;
        };
        response: {
          mime: "video/webm";
          base64: string;  // Raw WebM video data
          metadata: {
            status: string;
            type: "idle" | "processing" | "talking";
            folder: string;
            sourceFile: string;
          };
        };
      };

      /**
       * Load all animated sprites for a given type.
       */
      loadAnimatedSpritesForType: {
        params: {
          status: string;
          type: "idle" | "processing" | "talking";
        };
        response: {
          sprites: Record<string, {
            mime: "video/webm";
            base64: string;
            metadata: {
              status: string;
              type: "idle" | "processing" | "talking";
              folder: string;
              sourceFile: string;
            };
          }>;
        };
      };

      /** Load a one-shot override animation from the active companion pack's assets/sprites/one-time/<key>/ */
      loadOverrideSpriteSheet: {
        params: {
          key: string;
        };
        response: {
          mime: "video/webm";
          base64: string;
          metadata: {
            key: string;
            sourceFile: string;
          };
        };
      };

      /** Companion packs */
      listCompanionPacks: {
        params: {};
        response: {
          activePackID: string;
          packs: Array<{ id: string; name: string; version: string; description?: string; source: "env" | "user" | "project" | "builtin" }>;
        };
      };

      getActiveCompanionPack: {
        params: {};
        response: {
          packID: string;
        };
      };

      setActiveCompanionPack: {
        params: {
          packID: string;
        };
        response: {
          success: boolean;
          packID: string;
          sessionID: string;
          defaultStatus: string;
        };
      };

      /** Settings - Allow AI to trigger one-shot avatar overrides */
      getAvatarOverrideAllowAi: {
        params: {};
        response: {
          allowAi: boolean;
        };
      };

      setAvatarOverrideAllowAi: {
        params: {
          allowAi: boolean;
        };
        response: {
          success: boolean;
          allowAi: boolean;
        };
      };

      getPlaywrightSettings: {
        params: {};
        response: {
          enabled: boolean;
          installed: boolean;
          browsersDir: string;
          executablePath: string | null;
        };
      };

      setPlaywrightEnabled: {
        params: { enabled: boolean };
        response: {
          enabled: boolean;
          installed: boolean;
          browsersDir: string;
          executablePath: string | null;
        };
      };

      getFirecrawlSettings: {
        params: {};
        response: {
          enabled: boolean;
          hasApiKey: boolean;
        };
      };

      setFirecrawlSettings: {
        params: { enabled: boolean; apiKey?: string };
        response: {
          enabled: boolean;
          hasApiKey: boolean;
        };
      };

      // Parakeet Model Management
      getParakeetModelUrls: {
        params: {
          encoderQuant?: "fp32" | "int8";
          decoderQuant?: "fp32" | "int8";
          preprocessor?: "nemo128" | "nemo80";
        };
        response: {
          urls: {
            encoderUrl: string;
            decoderUrl: string;
            encoderDataUrl: string | null;
            decoderDataUrl: string | null;
            tokenizerUrl: string;
            preprocessorUrl: string;
          };
          filenames: {
            encoder: string;
            decoder: string;
          };
        };
      };

      // Memory System
      getMemoryStats: {
        params: {};
        response: {
          totalInteractions: number;
          todayInteractions: number;
          totalScreenshots: number;
          totalDailySummaries: number;
          oldestInteraction: number | null;
          newestInteraction: number | null;
          profileHasContent: boolean;
        };
      };

      triggerDailySummary: {
        params: {};
        response: {
          date: string;
          summary: string;
          interactionCount: number;
          profileUpdates: unknown;
          savedToFile: boolean;
        } | null;
      };

      getProfileSummary: {
        params: {};
        response: {
          summary: string;
        };
      };

      searchMemory: {
        params: {
          query: string;
          limit?: number;
        };
        response: {
          results: Array<{
            content: string;
            role: "user" | "assistant" | "system" | "tool";
            timestamp: number;
            sessionId: string | null;
            turnId: string | null;
            snippet: string;
            relevance: number;
          }>;
        };
      };

      findMemoryContext: {
        params: {
          question: string;
        };
        response: {
          context: string;
          sourceCount: number;
        };
      };

      getMemorySettings: {
        params: {};
        response: {
          enabled: boolean;
          conversationLoggingEnabled: boolean;
          screenshotLoggingEnabled: boolean;
          ocrEnabled: boolean;
          retentionDays: number | null;
          profileLearningEnabled: boolean;
          redactedTerms: string[];
        };
      };

      setMemorySettings: {
        params: {
          enabled?: boolean;
          conversationLoggingEnabled?: boolean;
          screenshotLoggingEnabled?: boolean;
          ocrEnabled?: boolean;
          retentionDays?: number | null;
          profileLearningEnabled?: boolean;
          redactedTerms?: string[];
        };
        response: {
          enabled: boolean;
          conversationLoggingEnabled: boolean;
          screenshotLoggingEnabled: boolean;
          ocrEnabled: boolean;
          retentionDays: number | null;
          profileLearningEnabled: boolean;
          redactedTerms: string[];
        };
      };

      getGBrainStatus: {
        params: {};
        response: {
          installed: boolean;
          configured: boolean;
          healthy: boolean;
          version?: string;
          integrationMode: "mcp" | "cli-call" | "disabled";
          error?: string;
        };
      };

      getGBrainSettings: {
        params: {};
        response: {
          enabled: boolean;
          command: string;
          home: string | null;
          integrationMode: "mcp" | "cli-call";
          contextLookupEnabled: boolean;
          writeMode: "off" | "propose" | "auto";
          timeoutMs: number;
          maxContextItems: number;
        };
      };

      setGBrainSettings: {
        params: {
          enabled?: boolean;
          command?: string;
          home?: string | null;
          integrationMode?: "mcp" | "cli-call";
          contextLookupEnabled?: boolean;
          writeMode?: "off" | "propose" | "auto";
          timeoutMs?: number;
          maxContextItems?: number;
        };
        response: {
          enabled: boolean;
          command: string;
          home: string | null;
          integrationMode: "mcp" | "cli-call";
          contextLookupEnabled: boolean;
          writeMode: "off" | "propose" | "auto";
          timeoutMs: number;
          maxContextItems: number;
        };
      };

      gbrainSearch: {
        params: { query: string; limit?: number };
        response: {
          results: Array<{
            slug: string;
            title?: string;
            type?: string;
            chunk_text?: string;
            chunk_source?: string;
            score?: number;
          }>;
        };
      };

      gbrainGetPage: {
        params: { slug: string };
        response: {
          page: {
            slug: string;
            title?: string;
            type?: string;
            content?: string;
            compiled_truth?: string;
            tags?: string[];
          };
        };
      };

      exportMemory: {
        params: {};
        response: {
          path: string;
        };
      };

      clearMemorySegment: {
        params: {
          segment: "all" | "conversations" | "screenshots" | "summaries" | "profile" | "tasks" | "reminders" | "routines" | "lists";
        };
        response: {
          success: boolean;
          clearedCount: number;
          segment: string;
        };
      };

      forgetLastTurn: {
        params: {};
        response: {
          success: boolean;
          turnID: string | null;
        };
      };

      clearMemory: {
        params: {};
        response: {
          success: boolean;
        };
      };

      logVoiceInteraction: {
        params: {
          content: string;
          role: "user" | "assistant";
          sessionId?: string;
        };
        response: {
          id: number | null;
        };
      };

      logAudioTranscript: {
        params: {
          source: "microphone" | "speaker";
          content: string;
          startedAt?: number;
          endedAt?: number;
          timestamp?: number;
          appName?: string;
          windowTitle?: string;
          sessionId?: string;
          turnId?: string;
          routedToAi?: boolean;
          durationMs?: number;
          sampleRate?: number;
          model?: string;
          language?: string;
          confidence?: number;
          captureBackend?: string;
          deviceName?: string;
          metadata?: Record<string, unknown>;
        };
        response: { id: number | null };
      };

      searchAudioTranscripts: {
        params: {
          query?: string;
          source?: "microphone" | "speaker" | "all";
          startTime?: number;
          endTime?: number;
          limit?: number;
        };
        response: {
          results: Array<{
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
          }>;
        };
      };

      getRecentAudioTranscripts: {
        params: { source?: "microphone" | "speaker" | "all"; minutes?: number; limit?: number };
        response: {
          results: Array<{
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
          }>;
        };
      };

      getMicrophoneSendToAi: { params: {}; response: { enabled: boolean } };
      setMicrophoneSendToAi: { params: { enabled: boolean }; response: { enabled: boolean } };
      getSpeakerTranscriptionEnabled: { params: {}; response: { enabled: boolean } };
      setSpeakerTranscriptionEnabled: { params: { enabled: boolean }; response: { enabled: boolean } };

      /** Inject context into the AI session without triggering a response */
      injectContext: {
        params: {
          text: string;
        };
        response: {
          success: boolean;
        };
      };

      // Agent: Providers/Auth/Models
      agentListProviders: {
        params: {};
        response: {
          all: Array<{
            id: string;
            name: string;
            env: string[];
            models: Record<string, { id: string; name: string }>;
          }>;
          default: Record<string, string>;
          connected: string[];
        };
      };

      agentGetAuthMethods: {
        params: {};
        response: Record<string, Array<{ type: "oauth" | "api"; label: string }>>;
      };

      agentSetApiKey: {
        params: {
          providerID: string;
          apiKey: string;
        };
        response: { success: boolean };
      };

      agentStartOAuth: {
        params: {
          providerID: string;
          methodIndex: number;
        };
        response: {
          url: string;
          method: "auto" | "code";
          instructions?: string;
        };
      };

      agentFinishOAuth: {
        params: {
          providerID: string;
          methodIndex: number;
          code?: string;
        };
        response: { success: boolean };
      };

      agentGetCurrentSessionId: {
        params: {};
        response: { sessionID: string };
      };

      agentClearSession: {
        params: {};
        response: { success: boolean; sessionID: string };
      };

      agentGetCurrentSessionHistory: {
        params: {};
        response: {
          sessionID: string;
          messageCount: number;
          messages: Array<{
            id: string;
            role: string;
            timestamp: number | null;
            content: string;
            partCount: number;
          }>;
        };
      };

      agentGetSessionModel: {
        params: { sessionID?: string };
        response: { sessionID: string; providerID: string; modelID: string } | null;
      };

      agentSetSessionModel: {
        params: { sessionID?: string; providerID: string; modelID: string };
        response: { success: boolean; sessionID: string; providerID: string; modelID: string };
      };

      agentGetThinkingLevel: {
        params: {};
        response: { variant: string };
      };

      agentSetThinkingLevel: {
        params: { variant: string };
        response: { success: boolean; variant: string };
      };

      getMessagesForDay: {
        params: {
          startTime: number;
          endTime: number;
        };
        response: Array<{
          id: number;
          type: string;
          role: "user" | "assistant" | "system" | "tool";
          content: string;
          timestamp: number;
          session_id: string | null;
          metadata: string | null;
        }>;
      };

      getLocalModelSettings: {
        params: {};
        response: {
          reasoning: "on" | "off" | "auto";
          reasoningBudget: number;
          contextSize: number;
        };
      };

      setLocalModelSettings: {
        params: {
          reasoning: "on" | "off" | "auto";
          reasoningBudget: number;
          contextSize: number;
        };
        response: {
          success: boolean;
          reasoning: "on" | "off" | "auto";
          reasoningBudget: number;
          contextSize: number;
        };
      };

      // Routines System
      getPendingRoutines: {
        params: {};
        response: {
          routines: Array<{
            id: number;
            name: string;
            description: string | null;
            scheduleType: string;
            scheduleValue: string | null;
          }>;
        };
      };

      getAllRoutines: {
        params: {};
        response: {
          routines: Array<{
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
          }>;
        };
      };

      completeRoutine: {
        params: {
          id: number;
        };
        response: {
          success: boolean;
          name: string;
        };
      };

      uncompleteRoutine: {
        params: {
          id: number;
        };
        response: {
          success: boolean;
          name: string;
        };
      };

      snoozeRoutine: {
        params: {
          id: number;
          duration: string; // e.g., "1h", "30m"
        };
        response: {
          success: boolean;
          name: string;
          snoozedUntil: string;
        };
      };

      toggleRoutine: {
        params: {
          id: number;
        };
        response: {
          success: boolean;
          name: string;
          enabled: boolean;
        };
      };

      deleteRoutine: {
        params: {
          id: number;
        };
        response: {
          success: boolean;
          name: string;
        };
      };

      checkRoutineReminders: {
        params: {};
        response: {
          hasPending: boolean;
          routineNames: string[];
        };
      };

      acknowledgeRoutineTriggers: {
        params: {
          ids: number[];
        };
        response: {
          success: boolean;
          acknowledgedCount: number;
        };
      };

      failRoutineTriggers: {
        params: {
          ids: number[];
        };
        response: {
          success: boolean;
          failedCount: number;
        };
      };

      // Lists System
      getAllLists: {
        params: {};
        response: {
          lists: Array<{
            id: number;
            name: string;
            description: string | null;
            itemCount: number;
          }>;
        };
      };

      getListItems: {
        params: {
          listId: number;
        };
        response: {
          items: Array<{
            id: number;
            listId: number;
            content: string;
            position: number;
          }>;
        };
      };

      removeListItem: {
        params: {
          itemId: number;
        };
        response: {
          success: boolean;
        };
      };

      clearList: {
        params: {
          listId: number;
        };
        response: {
          success: boolean;
          clearedCount: number;
        };
      };

      deleteList: {
        params: {
          listId: number;
        };
        response: {
          success: boolean;
        };
      };

      // Tasks System
      getAllTasks: {
        params: {
          status?: "open" | "completed" | "cancelled";
        };
        response: {
          tasks: Array<{
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
          }>;
        };
      };

      createTask: {
        params: {
          title: string;
          description?: string;
          priority?: "low" | "normal" | "high";
          dueAt?: number;
          reminderAt?: number;
          listId?: number;
        };
        response: {
          success: boolean;
          id: number;
        };
      };

      completeTask: {
        params: { id: number };
        response: { success: boolean };
      };

      cancelTask: {
        params: { id: number };
        response: { success: boolean };
      };

      deleteTask: {
        params: { id: number };
        response: { success: boolean };
      };

      // Reminders System
      getAllReminders: {
        params: {};
        response: {
          reminders: Array<{
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
          }>;
        };
      };

      acknowledgeReminders: {
        params: {
          ids: number[];
        };
        response: {
          success: boolean;
          acknowledgedCount: number;
        };
      };

      deleteReminder: {
        params: {
          id: number;
        };
        response: {
          success: boolean;
        };
      };

      // Settings - Reminder Interval
      getReminderInterval: {
        params: {};
        response: {
          intervalMinutes: number;
        };
      };

      setReminderInterval: {
        params: {
          intervalMinutes: number;
        };
        response: {
          success: boolean;
          intervalMinutes: number;
        };
      };

      // Mute state
      setMuted: {
        params: {
          muted: boolean;
        };
        response: {
          success: boolean;
          muted: boolean;
        };
      };

      getMuted: {
        params: {};
        response: {
          muted: boolean;
        };
      };

      // Save screenshot from webview to file
      saveScreenshotToFile: {
        params: {
          imageData: string; // base64 encoded PNG
          filePath: string;
        };
        response: {
          success: boolean;
          path: string;
        };
      };
    };
    messages: {
      // Window focus/blur notifications from webview
      windowFocus: {};
      windowBlur: {};
      // Voice activity notification for routine reminders
      voiceActivity: {};
    };
  }>;

  webview: RPCSchema<{
    requests: {
      playAudio: {
        params: {
          audioData: string; // base64 encoded
          volume?: number; // 0.0 to 1.0, defaults to 1.0
          rate?: number; // Playback speed, 0.5 to 4.0, defaults to 1.25 (25% faster)
        };
        response: void;
      };
    };
    messages: {
      // Messages from bun to webview
      setState: {
        state: "idle" | "processing" | "talking";
        /** Optional turn-scoped sequencing guard for stale-event protection. */
        turnId?: string;
        /** Optional reason for observability/debugging. */
        reason?: string;
      };
      setAvatarStatus: {
        status: string;
      };

      /** Start follow-up mode (used to treat subsequent speech as a follow-up) */
      activateFollowupMode: {
        turnId?: string;
        reason?: string;
      };

      /** Trigger a one-shot override animation (cosmetic). The avatar will revert automatically. */
      setOverrideState: {
        key: string;
      };

      showResponse: {
        text: string;
      };

      appendResponse: {
        delta: string;
      };

      showUserQuestion: {
        question: string;
      };

      showToast: {
        message: string;
        duration?: number; // milliseconds, defaults to 4000
      };

      speakerAudioSegment: {
        base64: string;
        sampleRate: number;
        startedAt: number;
        endedAt: number;
        durationMs: number;
        captureBackend: string;
        deviceName?: string;
      };

      // Streaming updates during agentic workflow
      agentUpdate: {
        type: "tool_start" | "tool_end" | "processing" | "text_delta" | "thought_delta" | "complete" | "error";
        toolName?: string;
        message?: string;
        delta?: string; // Incremental text for streaming
        thought?: string; // Incremental thinking/reasoning text
        args?: unknown; // Tool arguments/input for tool_start/tool_end events
        result?: unknown; // Tool result/output for tool_end events
        error?: string; // Error message for error events
        callId?: string; // Tool call id when available
        partIndex?: number; // For text_delta events
        fullText?: string; // For text_delta events (cumulative full text)
        turnId?: string;
        reason?: string;
      };

      error: {
        message: string;
        type: "agent" | "tts" | "screenshot" | "notes" | "general";
      };

      logMessage: {
        level: 'info' | 'warn' | 'error';
        message: string;
      };

      // CLI args passed from backend
      initWithCliArgs: {
        waitSeconds?: number;
        chatMessage?: string;
        includeScreenshot?: boolean;
        activeWindowOnly?: boolean; // Capture only active window (vs full screen)
        reconcileProfile?: boolean;
        checkReminders?: boolean;
        openModal?: "history" | "current-session" | "routines" | "lists" | "transcripts" | "tasks" | "reminders";
        openSettings?: boolean;
        settingsScroll?: number;
        takeScreenshot?: string;
        // Contextual conversation testing
        injectContext?: string;
        testSilent?: boolean;
        testInterruptSeconds?: number; // Trigger interrupt after N seconds
        testRapidQuestions?: string[]; // Send multiple questions quickly
        testInterruptThenChat?: {
          firstMessage: string;
          secondMessage: string;
          interruptAfterSeconds: number;
        };
      };

      // Sprite processing progress
      spriteProcessingProgress: {
        step: string;
        progress: number; // 0-100
      };

      // Sprite processing complete
      spriteProcessingComplete: {
        success: boolean;
        message: string;
      };

      // Trigger routine reminder via AI
      triggerRoutineReminder: {
        routines: Array<{ id: number; name: string; goal?: string; prompt?: string; triggerId: number; periodKey: string }>;
      };

      // Trigger one-time reminders via AI
      triggerOneTimeReminders: {
        reminders: Array<{ id: number; content: string }>;
      };
    };
  }>;
};
