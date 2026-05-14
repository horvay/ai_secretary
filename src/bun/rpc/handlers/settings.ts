import { logDebug, logInfo, logWarn, logError } from "../../utils/logger";
import type { AppRpc } from "../../types/app-rpc";
import type { AgentClientInstance } from "../../services/agent/types";
import { screenshotService } from "../../services/screenshot";
import { spritesService } from "../../services/sprites";
import { getActiveCompanionPackID, listCompanionPacks, setActiveCompanionPackID } from "../../services/companion-packs";
import { getAppState, setAppState, getSetting, setSetting } from "../../services/app-state";
import { setMuted as setBackendMuted, getMuted as getBackendMuted } from "../../services/audio";
import {
  downloadModelFiles,
  startModelServer,
} from "../../services/parakeet-models";
import {
  getCheckInterval,
  setCheckInterval,
} from "../../services/routineScheduler";
import { ensureManagedChromiumDownloaded, getManagedPlaywrightBrowserStatus } from "../../services/playwright-browser";
import { getFirecrawlSettingsStatus } from "../../services/firecrawl";

export interface SettingsHandlerDeps {
  rpc: AppRpc;
  getAgentClient: () => Promise<AgentClientInstance>;
}

export function createSettingsHandlers({ rpc, getAgentClient }: SettingsHandlerDeps) {
  return {
    // Avatar State Control
    setAvatarState: async ({ state }: { state: "idle" | "processing" | "talking" }) => {
      rpc.send.setState({ state });
      return;
    },

    // Screenshot
    captureScreenshot: async ({ activeWindowOnly }: { activeWindowOnly?: boolean }) => {
      try {
        const image = activeWindowOnly
          ? await screenshotService.captureActiveWindow()
          : await screenshotService.capture();
        return { image };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        rpc.send.error({
          message: errorMessage,
          type: "screenshot",
        });
        throw error;
      }
    },

    // Sprite Management
    getSpriteInfo: async () => {
      try {
        const info = await spritesService.getSpriteInfo();
        return info;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        rpc.send.error({
          message: errorMessage,
          type: "general",
        });
        throw error;
      }
    },

    /**
     * Load a single animated sprite (WebM video)
     */
    loadAnimatedSprite: async ({
      status,
      type,
      folder,
    }: {
      status: string;
      type: "idle" | "processing" | "talking";
      folder: string;
    }) => {
      console.log(`[RPC] loadAnimatedSprite called: ${status}/${type}/${folder}`);
      try {
        const t0 = Date.now();
        const sprite = await spritesService.loadAnimatedSprite(status, type, folder);
        const t1 = Date.now();

        logDebug(
          `[Sprites] loadAnimatedSprite ${status}/${type}/${folder}: ${sprite.bytes.length} bytes, ${t1 - t0}ms`
        );

        return {
          mime: sprite.mime,
          base64: Buffer.from(sprite.bytes).toString("base64"),
          metadata: sprite.metadata,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        rpc.send.error({
          message: errorMessage,
          type: "general",
        });
        throw error;
      }
    },

    /**
     * Load all animated sprites for a type
     */
    loadAnimatedSpritesForType: async ({
      status,
      type,
    }: {
      status: string;
      type: "idle" | "processing" | "talking";
    }) => {
      try {
        const t0 = Date.now();
        const spritesMap = await spritesService.loadAnimatedSpritesForType(status, type);
        const t1 = Date.now();

        const sprites: Record<
          string,
          {
            mime: "video/webm";
            base64: string;
            metadata: {
              status: string;
              type: "idle" | "processing" | "talking";
              folder: string;
              sourceFile: string;
            };
          }
        > = {};

        for (const [folder, sprite] of Object.entries(spritesMap)) {
          sprites[folder] = {
            mime: sprite.mime,
            base64: Buffer.from(sprite.bytes).toString("base64"),
            metadata: sprite.metadata,
          };
        }

        logDebug(
          `[Sprites] loadAnimatedSpritesForType ${status}/${type}: ${Object.keys(spritesMap).length} sprites, ${t1 - t0}ms`
        );

        return { sprites };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        rpc.send.error({
          message: errorMessage,
          type: "general",
        });
        throw error;
      }
    },

    loadOverrideSpriteSheet: async ({ key }: { key: string }) => {
      try {
        const sprite = await spritesService.loadOverrideSpriteSheet(key);
        return {
          mime: sprite.mime,
          base64: Buffer.from(sprite.bytes).toString("base64"),
          metadata: {
            key: sprite.metadata.folder,
            sourceFile: sprite.metadata.sourceFile,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        rpc.send.error({
          message: errorMessage,
          type: "general",
        });
        throw error;
      }
    },

    listCompanionPacks: async () => {
      const packs = await listCompanionPacks();
      return { activePackID: getActiveCompanionPackID(), packs };
    },

    getActiveCompanionPack: async () => {
      return { packID: getActiveCompanionPackID() };
    },

    setActiveCompanionPack: async ({ packID }: { packID: string }) => {
      const previousPackID = getActiveCompanionPackID();
      const previousStatus = String(getAppState("secretary.status") ?? "").trim();
      const pack = await setActiveCompanionPackID(packID);

      try {
        const client = await getAgentClient();
        const sessionID = await client.clearSession();
        const defaultStatus = pack.manifest.sprites.defaultStatus;
        setAppState("secretary.status", defaultStatus);
        rpc.send.setAvatarStatus({ status: defaultStatus });
        return { success: true, packID: pack.manifest.id, sessionID, defaultStatus };
      } catch (error) {
        if (previousPackID !== pack.manifest.id) {
          try {
            await setActiveCompanionPackID(previousPackID);
          } catch (rollbackError) {
            logWarn(`[Settings] Failed to roll back companion pack to ${previousPackID}:`, rollbackError);
          }
        }

        if (previousStatus) {
          try {
            setAppState("secretary.status", previousStatus);
            rpc.send.setAvatarStatus({ status: previousStatus });
          } catch (rollbackError) {
            logWarn(`[Settings] Failed to restore secretary.status=${previousStatus}:`, rollbackError);
          }
        }

        throw error;
      }
    },

    getAvatarOverrideAllowAi: async () => {
      const raw = getAppState("avatarOverride.allowAi");
      // Default: off (user must opt-in)
      const allowAi = raw === "1" || raw === "true";
      return { allowAi };
    },

    setAvatarOverrideAllowAi: async ({ allowAi }: { allowAi: boolean }) => {
      setAppState("avatarOverride.allowAi", allowAi ? "1" : "0");
      return { success: true, allowAi };
    },

    getPlaywrightSettings: async () => {
      return getManagedPlaywrightBrowserStatus(getSetting("playwright.enabled"));
    },

    setPlaywrightEnabled: async ({ enabled }: { enabled: boolean }) => {
      if (enabled) {
        rpc.send.logMessage({
          level: "info",
          message: "Playwright browser automation enabled. Downloading the managed Chromium binary for this platform if needed…",
        });
        await ensureManagedChromiumDownloaded((message) => {
          rpc.send.logMessage({ level: "info", message });
        });
      }
      setSetting("playwright.enabled", enabled);
      return getManagedPlaywrightBrowserStatus(enabled);
    },

    getFirecrawlSettings: async () => {
      return getFirecrawlSettingsStatus();
    },

    setFirecrawlSettings: async ({ enabled, apiKey }: { enabled: boolean; apiKey?: string }) => {
      if (typeof apiKey === "string") setSetting("firecrawl.apiKey", apiKey.trim());
      setSetting("firecrawl.enabled", enabled);
      return getFirecrawlSettingsStatus();
    },

    // Parakeet Model Management
    getParakeetModelUrls: async ({
      encoderQuant = "int8",
      decoderQuant = "int8",
      preprocessor = "nemo128",
    }: {
      encoderQuant?: string;
      decoderQuant?: string;
      preprocessor?: string;
    }) => {
      try {
        // Start model server if not already running
        await startModelServer();

        // Get model files (downloads if needed) and URLs
        const { urls } = await downloadModelFiles(
          encoderQuant as "int8" | "fp32",
          decoderQuant as "int8" | "fp32",
          preprocessor as "nemo128" | "nemo80",
          (file, loaded, total) => {
            const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
            if (pct % 25 === 0 || pct === 100) {
              const mbLoaded = (loaded / (1024 * 1024)).toFixed(1);
              const mbTotal = (total / (1024 * 1024)).toFixed(1);
              rpc.send.logMessage({
                level: "info",
                message: `Downloading ${file}: ${pct}% (${mbLoaded}MB / ${mbTotal}MB)`,
              });
            }
          }
        );

        const encoderName = `encoder-model${encoderQuant === "int8" ? ".int8.onnx" : ".onnx"}`;
        const decoderName = `decoder_joint-model${decoderQuant === "int8" ? ".int8.onnx" : ".onnx"}`;

        return {
          urls,
          filenames: {
            encoder: encoderName,
            decoder: decoderName,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        rpc.send.error({
          message: errorMessage,
          type: "general",
        });
        throw error;
      }
    },

    /**
     * Get current reminder check interval
     */
    getReminderInterval: async () => {
      try {
        const intervalMs = getCheckInterval();
        const intervalMinutes = Math.round(intervalMs / 60000);
        logDebug(`[RPC] getReminderInterval: ${intervalMinutes} minutes`);
        return { intervalMinutes };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] getReminderInterval failed:", errorMessage);
        throw error;
      }
    },

    /**
     * Set reminder check interval
     */
    setReminderInterval: async ({ intervalMinutes }: { intervalMinutes: number }) => {
      try {
        // Minimum 5 minutes, maximum 24 hours
        const clampedMinutes = Math.max(5, Math.min(1440, intervalMinutes));
        const intervalMs = clampedMinutes * 60000;
        setCheckInterval(intervalMs);
        logInfo(`[RPC] setReminderInterval: ${clampedMinutes} minutes`);
        return { success: true, intervalMinutes: clampedMinutes };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] setReminderInterval failed:", errorMessage);
        throw error;
      }
    },

    getLocalModelSettings: async () => {
      const reasoning = getAppState("localModel.reasoning");
      return {
        reasoning: reasoning === "off" || reasoning === "auto" ? reasoning : "on",
        reasoningBudget: Number(getAppState("localModel.reasoningBudget")) || 500,
        contextSize: Number(getAppState("localModel.contextSize")) || 65_536,
      };
    },

    setLocalModelSettings: async ({
      reasoning,
      reasoningBudget,
      contextSize,
    }: {
      reasoning: "on" | "off" | "auto";
      reasoningBudget: number;
      contextSize: number;
    }) => {
      const sanitizedReasoning = reasoning === "off" || reasoning === "auto" ? reasoning : "on";
      const sanitizedBudget = Math.max(1, Math.min(8192, Math.round(reasoningBudget)));
      const sanitizedContextSize = Math.max(4096, Math.min(262144, Math.round(contextSize)));
      setAppState("localModel.reasoning", sanitizedReasoning);
      setAppState("localModel.reasoningBudget", sanitizedBudget);
      setAppState("localModel.contextSize", sanitizedContextSize);
      return {
        success: true,
        reasoning: sanitizedReasoning,
        reasoningBudget: sanitizedBudget,
        contextSize: sanitizedContextSize,
      };
    },

    /**
     * Set mute state
     */
    setMuted: async ({ muted }: { muted: boolean }) => {
      try {
        setBackendMuted(muted);
        logInfo(`[RPC] setMuted: ${muted}`);
        return { success: true, muted };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] setMuted failed:", errorMessage);
        throw error;
      }
    },

    /**
     * Get mute state
     */
    getMuted: async () => {
      try {
        return { muted: getBackendMuted() };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] getMuted failed:", errorMessage);
        throw error;
      }
    },

    /**
     * Save a screenshot (base64 PNG) to a file
     * Includes path validation to prevent directory traversal attacks
     */
    saveScreenshotToFile: async ({ imageData, filePath }: { imageData: string; filePath: string }) => {
      try {
        const fs = await import("fs");
        const { validateFilePath, validateBase64 } = await import("../../utils/validation");

        // Validate path for security (prevents path traversal, enforces allowed directories)
        const pathResult = validateFilePath(filePath, {
          allowedExtensions: [".png"],
        });
        if (!pathResult.valid) {
          logWarn(`[RPC] Path validation failed: ${pathResult.error}`);
          throw new Error(pathResult.error);
        }

        // Validate image data is valid base64
        const imageResult = validateBase64(imageData, "imageData");
        if (!imageResult.valid) {
          logWarn(`[RPC] Image validation failed: ${imageResult.error}`);
          throw new Error(imageResult.error);
        }

        const safePath = pathResult.sanitized!;

        // Ensure directory exists
        const { dirname } = await import("path");
        const dir = dirname(safePath);
        await fs.promises.mkdir(dir, { recursive: true });

        // Decode base64 and write to file (async)
        const buffer = Buffer.from(imageData, "base64");
        await fs.promises.writeFile(safePath, buffer);

        logInfo(`[RPC] Screenshot saved to: ${safePath}`);
        console.log(`📸 Screenshot saved: ${safePath}`);

        return { success: true, path: safePath };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] saveScreenshotToFile failed:", errorMessage);
        throw error;
      }
    },
  };
}
