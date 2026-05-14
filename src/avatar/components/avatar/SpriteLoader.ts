/**
 * Sprite Loader
 * Loads WebM video sprites - stores video elements directly for instant playback.
 * No frame extraction needed - videos play natively!
 */

import type { AvatarState, AvatarStatus, SpriteRPC, VideoSprite, AnimatedSpriteMetadata } from "./types";

type Logger = (message: string, ...args: unknown[]) => void;
type IdleCallback = (deadline?: IdleDeadline) => void;

export interface SpriteLoaderDeps {
  getSpriteRPC: () => SpriteRPC | null;
  element: HTMLElement;
  DEFAULT_AVATAR_STATUS: AvatarStatus;
  BACKGROUND_LOAD_START_DELAY_MS: number;
  BACKGROUND_LOAD_INTER_TASK_DELAY_MS: number;
  BACKGROUND_LOAD_MIN_IDLE_MS: number;
  logDebug: Logger;
  logWarn: Logger;
  logError: Logger;
  scheduleIdleWork: (cb: IdleCallback) => number;
  cancelIdleWork: (handle: number) => void;
  ensureStatusMaps: (status: AvatarStatus) => void;
  startAnimation: () => void;
  stopAnimation: () => void;
  workerCall: (payload: Record<string, unknown>, transfer?: Transferable[]) => Promise<void>;
  getUsingWorkerRenderer: () => boolean;
  getRenderWorker: () => Worker | null;
  getCurrentStatus: () => AvatarStatus;
  setCurrentStatus: (status: AvatarStatus) => void;
  getCurrentState: () => AvatarState;
  isLoaded: () => boolean;
  setIsLoaded: (loaded: boolean) => void;
  isAnimationActive: () => boolean;
  decodedSprites: Record<AvatarStatus, Record<AvatarState, Record<string, VideoSprite>>>;
  availableFolders: Record<AvatarStatus, Record<AvatarState, string[]>>;
  knownFolders: Record<AvatarStatus, Record<AvatarState, string[]>>;
  loadingFolders: Set<string>;
  getBackgroundLoading: () => boolean;
  setBackgroundLoading: (value: boolean) => void;
  getBackgroundLoadHandle: () => number | null;
  setBackgroundLoadHandle: (handle: number | null) => void;
  getBackgroundStartTimer: () => number | null;
  setBackgroundStartTimer: (handle: number | null) => void;
}

export function createSpriteLoader(deps: SpriteLoaderDeps) {
  const {
    getSpriteRPC,
    element,
    DEFAULT_AVATAR_STATUS,
    BACKGROUND_LOAD_START_DELAY_MS,
    BACKGROUND_LOAD_INTER_TASK_DELAY_MS,
    BACKGROUND_LOAD_MIN_IDLE_MS,
    logDebug,
    logWarn,
    logError,
    scheduleIdleWork,
    cancelIdleWork,
    ensureStatusMaps,
    startAnimation,
    stopAnimation,
    getCurrentStatus,
    setCurrentStatus,
    getCurrentState,
    isLoaded,
    setIsLoaded,
    isAnimationActive,
    decodedSprites,
    availableFolders,
    knownFolders,
    loadingFolders,
    getBackgroundLoading,
    setBackgroundLoading,
    getBackgroundLoadHandle,
    setBackgroundLoadHandle,
    getBackgroundStartTimer,
    setBackgroundStartTimer,
  } = deps;

  /**
   * Create a video element from base64 data - nearly instant!
   */
  async function createVideoFromBase64(
    base64: string,
    metadata: AnimatedSpriteMetadata
  ): Promise<VideoSprite | null> {
    return new Promise((resolve) => {
      try {
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.loop = true;
        video.preload = 'auto';

        // Hide the video element
        video.style.position = 'absolute';
        video.style.left = '-9999px';
        video.style.width = '1px';
        video.style.height = '1px';

        // Convert base64 to blob
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: 'video/webm' });
        const blobUrl = URL.createObjectURL(blob);
        video.src = blobUrl;

        video.onloadedmetadata = () => {
          const sprite: VideoSprite = {
            video,
            duration: video.duration,
            width: video.videoWidth,
            height: video.videoHeight,
            blobUrl,
            metadata,
          };

          // Start playing immediately (muted, so no autoplay restrictions)
          video.play().catch(() => {
            // Autoplay might fail, that's ok - we'll start it when needed
          });

          resolve(sprite);
        };

        video.onerror = () => {
          logWarn(`   Video load error for ${metadata.folder}`);
          URL.revokeObjectURL(blobUrl);
          resolve(null);
        };

        // Add to DOM (required for some browsers to load properly)
        document.body.appendChild(video);
        video.load();
      } catch (e) {
        logWarn(`   createVideoFromBase64 error:`, e);
        resolve(null);
      }
    });
  }

  /**
   * Load and store a video sprite for a specific folder
   */
  async function loadAnimatedSpriteForFolder(
    status: AvatarStatus,
    type: AvatarState,
    folder: string
  ): Promise<void> {
    const spriteRPC = getSpriteRPC();
    if (!spriteRPC) {
      logWarn("⚠️ Sprite RPC not available");
      return;
    }

    ensureStatusMaps(status);
    const folderKey = `${status}/${type}/${folder}`;

    if (decodedSprites[status][type][folder] || loadingFolders.has(folderKey)) return;

    loadingFolders.add(folderKey);

    try {
      const rpcStart = performance.now();
      const result = await spriteRPC.loadAnimatedSprite({ status, type, folder });
      const rpcEnd = performance.now();

      const createStart = performance.now();
      const sprite = await createVideoFromBase64(result.base64, result.metadata);
      const createEnd = performance.now();

      if (!sprite) {
        logWarn(`   ⚠️ Failed to create video for ${folder}`);
        loadingFolders.delete(folderKey);
        return;
      }

      decodedSprites[status][type][folder] = sprite;

      if (!availableFolders[status][type].includes(folder)) {
        availableFolders[status][type] = [...availableFolders[status][type], folder].sort();
      }

      logDebug(
        `   ✅ Loaded ${folder}: ${sprite.width}x${sprite.height}, ${sprite.duration.toFixed(2)}s (rpc=${Math.round(rpcEnd - rpcStart)}ms, create=${Math.round(createEnd - createStart)}ms)`
      );

      if (isLoaded() && getCurrentState() === type && getCurrentStatus() === status && !isAnimationActive()) {
        startAnimation();
      }
    } catch (error) {
      logWarn(`⚠️ Failed to load sprite ${folderKey}:`, error);
    } finally {
      loadingFolders.delete(folderKey);
    }
  }

  /**
   * Load all animated sprites for a specific type
   */
  async function loadAnimatedSpritesForType(status: AvatarStatus, type: AvatarState): Promise<void> {
    const spriteRPC = getSpriteRPC();
    if (!spriteRPC) {
      logWarn("⚠️ Sprite RPC not available");
      return;
    }

    try {
      ensureStatusMaps(status);
      logDebug(`📦 Loading ${status}/${type} sprites...`);
      const result = await spriteRPC.loadAnimatedSpritesForType({ status, type });

      const folders: string[] = [];

      for (const [folder, spriteData] of Object.entries(result.sprites)) {
        const sprite = await createVideoFromBase64(spriteData.base64, spriteData.metadata);

        if (!sprite) {
          logWarn(`   ⚠️ Failed to create video for ${folder}`);
          continue;
        }

        decodedSprites[status][type][folder] = sprite;
        folders.push(folder);
        logDebug(`   ✅ Loaded ${folder}: ${sprite.duration.toFixed(2)}s`);
      }

      availableFolders[status][type] = folders.sort();
    } catch (error) {
      logWarn(`⚠️ Failed to load ${status}/${type} sprites:`, error);
    }
  }

  /**
   * Boot-time load: load ONE animation for first paint, then background-load everything else.
   */
  async function loadSpritesHybrid(): Promise<void> {
    const spriteRPC = getSpriteRPC();
    if (!spriteRPC) {
      console.warn("⚠️ Sprite RPC not available");
      element.classList.add("missing-assets");
      return;
    }

    try {
      const loadStart = performance.now();
      const info = await spriteRPC.getSpriteInfo();
      logDebug("📋 Sprite info:", info);

      if (!info.hasSprites) {
        logWarn("⚠️ No sprites found. Add WebM files to the sprites folder.");
        element.classList.add("missing-assets");
        return;
      }

      const statuses = (info.statuses && info.statuses.length > 0 ? info.statuses : [DEFAULT_AVATAR_STATUS]).slice();

      for (const status of statuses) {
        ensureStatusMaps(status);
        const statusFolders = info.folders?.[status] ?? {};
        knownFolders[status] = {
          idle: ((statusFolders.idle ?? []) as string[]).slice(),
          processing: ((statusFolders.processing ?? []) as string[]).slice(),
          talking: ((statusFolders.talking ?? []) as string[]).slice(),
        };
      }

      if (!statuses.includes(getCurrentStatus())) {
        logWarn(`⚠️ Unknown status "${getCurrentStatus()}", falling back to "${DEFAULT_AVATAR_STATUS}"`);
        setCurrentStatus(DEFAULT_AVATAR_STATUS);
      }

      const statusFolders = knownFolders[getCurrentStatus()];
      const idleFolders = (statusFolders?.idle ?? []).slice();
      const processingFolders = (statusFolders?.processing ?? []).slice();
      const talkingFolders = (statusFolders?.talking ?? []).slice();

      if (idleFolders.length === 0) {
        logWarn(`⚠️ No idle sprites for status "${getCurrentStatus()}"`);
        element.classList.add("missing-assets");
        return;
      }

      // First paint: load just one idle folder
      const initialIdleFolder = idleFolders[0];
      logDebug(`🚀 Initial load: ${getCurrentStatus()}/idle/${initialIdleFolder}`);
      await loadAnimatedSpriteForFolder(getCurrentStatus(), "idle", initialIdleFolder);

      setIsLoaded(true);
      element.classList.remove("missing-assets");
      startAnimation();
      logDebug(`⏱️ Avatar ready in ${Math.round(performance.now() - loadStart)}ms`);

      if ((window as unknown as { __aiSecretaryDisableSpritePreload?: boolean }).__aiSecretaryDisableSpritePreload !== false) {
        logDebug("🧊 Background sprite preload disabled to avoid Chromium video decode crashes during window movement");
        return;
      }

      // Background-load remaining folders
      setBackgroundLoading(true);
      const remainingIdle = idleFolders.filter((f) => f !== initialIdleFolder);

      const tasks: Array<() => Promise<void>> = [
        ...(processingFolders[0] != null
          ? [() => loadAnimatedSpriteForFolder(getCurrentStatus(), "processing", processingFolders[0])]
          : []),
        ...(talkingFolders[0] != null
          ? [() => loadAnimatedSpriteForFolder(getCurrentStatus(), "talking", talkingFolders[0])]
          : []),
        ...remainingIdle.map((folder) => () => loadAnimatedSpriteForFolder(getCurrentStatus(), "idle", folder)),
        ...processingFolders.slice(1).map((folder) => () => loadAnimatedSpriteForFolder(getCurrentStatus(), "processing", folder)),
        ...talkingFolders.slice(1).map((folder) => () => loadAnimatedSpriteForFolder(getCurrentStatus(), "talking", folder)),
      ];

      const pump = async (): Promise<void> => {
        if (!getBackgroundLoading()) return;

        const next = tasks.shift();
        if (!next) {
          setBackgroundLoading(false);
          logDebug("✅ Background load complete");
          return;
        }

        try {
          await next();
        } catch (error) {
          logWarn("⚠️ Background load step failed:", error);
        }

        setBackgroundLoadHandle(window.setTimeout(() => {
          setBackgroundLoadHandle(scheduleIdleWork((deadline) => {
            if (deadline && deadline.timeRemaining && deadline.timeRemaining() < BACKGROUND_LOAD_MIN_IDLE_MS) {
              setBackgroundLoadHandle(scheduleIdleWork(() => {
                void pump();
              }));
              return;
            }
            void pump();
          }));
        }, BACKGROUND_LOAD_INTER_TASK_DELAY_MS) as unknown as number);
      };

      setBackgroundStartTimer(window.setTimeout(() => {
        setBackgroundLoadHandle(scheduleIdleWork(() => {
          void pump();
        }));
      }, BACKGROUND_LOAD_START_DELAY_MS) as unknown as number);
    } catch (error) {
      logError("❌ Failed to load sprites:", error);
      element.classList.add("missing-assets");
    }
  }

  /**
   * Reload sprites
   */
  async function reloadSprites(): Promise<void> {
    stopAnimation();
    if (getBackgroundLoadHandle()) {
      cancelIdleWork(getBackgroundLoadHandle() as number);
      setBackgroundLoadHandle(null);
    }
    if (getBackgroundStartTimer()) {
      clearTimeout(getBackgroundStartTimer() as number);
      setBackgroundStartTimer(null);
    }
    setBackgroundLoading(false);

    // Clear current sprites and cleanup video elements
    for (const status of Object.keys(decodedSprites)) {
      for (const type of ["idle", "processing", "talking"] as AvatarState[]) {
        for (const sprite of Object.values(decodedSprites[status][type])) {
          // Cleanup video element
          sprite.video.pause();
          sprite.video.src = '';
          sprite.video.remove();
          URL.revokeObjectURL(sprite.blobUrl);
        }
        decodedSprites[status][type] = {};
        if (availableFolders[status]) {
          availableFolders[status][type] = [];
        }
        if (knownFolders[status]) {
          knownFolders[status][type] = [];
        }
      }
    }

    setIsLoaded(false);

    await loadSpritesHybrid();
  }

  return {
    loadAnimatedSpriteForFolder,
    loadAnimatedSpritesForType,
    loadSpritesHybrid,
    reloadSprites,
  };
}
