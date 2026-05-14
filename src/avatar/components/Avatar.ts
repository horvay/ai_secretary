/**
 * Avatar Component
 * Functional module for sprite display and animation states using WebM video files.
 */

import { logDebug, logWarn, logError } from "../utils/logger";
import { createSpriteLoader } from "./avatar/SpriteLoader";
import type { AvatarInstance, AvatarState, AvatarStatus, DecodedSprite, SpriteRPC, VideoSprite } from "./avatar/types";

export type {
  AvatarInstance,
  AvatarState,
  AvatarStatus,
  SpriteRPC,
  DecodedSprite,
} from "./avatar/types";

const DEFAULT_AVATAR_STATUS = "normal";

const FRAME_RATE = 10; // 10 FPS for animations
const FRAME_INTERVAL = 1000 / FRAME_RATE; // 100ms per frame

// Background loading tuning (startup smoothness)
const BACKGROUND_LOAD_START_DELAY_MS = 8000;
const BACKGROUND_LOAD_INTER_TASK_DELAY_MS = 50;
const BACKGROUND_LOAD_MIN_IDLE_MS = 12;

// Worker renderer pacing
const WORKER_FRAME_RATE = 16;

// Global RPC reference (set by index.ts)
let spriteRPC: SpriteRPC | null = null;

/**
 * Set the RPC interface for sprite loading
 */
export function setSpriteRPC(rpc: SpriteRPC): void {
  spriteRPC = rpc;
}

/**
 * Create an Avatar instance with closure-based state
 */
export function createAvatar(elementId: string = "avatar-canvas"): AvatarInstance {
  let canvas = document.getElementById(elementId) as HTMLCanvasElement;
  if (!canvas) {
    throw new Error(`Avatar canvas #${elementId} not found`);
  }

  // 2D rendering context
  let ctx: CanvasRenderingContext2D | null = null;
  let canvasTransferredToOffscreen = false;

  function getCtx(): CanvasRenderingContext2D {
    if (canvasTransferredToOffscreen) {
      throw new Error("Avatar canvas was transferred to OffscreenCanvas; cannot use main-thread 2D context");
    }
    if (!ctx) {
      ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Failed to get 2D context for avatar canvas");
    }
    return ctx;
  }

  let element = canvas;

  function rejectAllWorkerPending(reason: string, err?: unknown): void {
    if (workerPending.size === 0) return;
    const error = new Error(`${reason}${err ? `: ${String((err as any)?.message ?? err)}` : ""}`);
    for (const pending of workerPending.values()) {
      try { pending.reject(error); } catch { /* ignore */ }
    }
    workerPending.clear();
  }

  function recoverFromWorkerFailure(reason: string, err?: unknown): void {
    if (!canvasTransferredToOffscreen) {
      usingWorkerRenderer = false;
      workerRenderStarted = false;
      rejectAllWorkerPending(`Worker renderer disabled (${reason})`, err);
      if (renderWorker) {
        try { renderWorker.terminate(); } catch { /* ignore */ }
        renderWorker = null;
      }
      return;
    }

    logWarn("⚠️ Worker renderer failed after OffscreenCanvas transfer; recreating canvas:", reason, err);

    usingWorkerRenderer = false;
    workerRenderStarted = false;
    rejectAllWorkerPending(`Worker renderer failed after transfer (${reason})`, err);
    if (renderWorker) {
      try { renderWorker.terminate(); } catch { /* ignore */ }
      renderWorker = null;
    }

    const oldCanvas = canvas;
    const parent = oldCanvas.parentElement;
    const newCanvas = oldCanvas.cloneNode(false) as HTMLCanvasElement;
    newCanvas.width = oldCanvas.width;
    newCanvas.height = oldCanvas.height;
    if (parent) parent.replaceChild(newCanvas, oldCanvas);

    canvas = newCanvas;
    element = newCanvas;
    ctx = null;
    canvasTransferredToOffscreen = false;

    if (isLoadedFlag) {
      stopAnimation();
      startAnimation();
    }
  }

  // Internal state
  let currentState: AvatarState = "idle";
  let currentStatus: AvatarStatus = DEFAULT_AVATAR_STATUS;
  let isLoadedFlag = false;
  const avatarInitAt = performance.now();
  let firstFrameRendered = false;

  // Worker renderer
  let renderWorker: Worker | null = null;
  let usingWorkerRenderer = false;
  let workerRequestSeq = 0;
  const workerPending = new Map<number, { resolve: () => void; reject: (e: unknown) => void }>();
  let workerRenderStarted = false;

  // Decoded sprites by status -> state -> folder
  const decodedSprites: Record<AvatarStatus, Record<AvatarState, Record<string, DecodedSprite>>> = {};

  // One-shot override
  let overrideKey: string | null = null;
  let overrideSprite: VideoSprite | null = null;
  let overrideStartedAt: number = 0;
  let overrideTtlMs: number = 0;
  const OVERRIDE_TTL_MS = 30000;
  const OVERRIDE_TTL_BUFFER_MS = 2000;
  const OVERRIDE_END_BUFFER_S = 0.05;

  // Available and known folders by status -> state
  const availableFolders: Record<AvatarStatus, Record<AvatarState, string[]>> = {};
  const loadingFolders = new Set<string>();
  const knownFolders: Record<AvatarStatus, Record<AvatarState, string[]>> = {};

  function ensureStatusMaps(status: AvatarStatus): void {
    if (!decodedSprites[status]) {
      decodedSprites[status] = { idle: {}, processing: {}, talking: {} };
    }
    if (!availableFolders[status]) {
      availableFolders[status] = { idle: [], processing: [], talking: [] };
    }
    if (!knownFolders[status]) {
      knownFolders[status] = { idle: [], processing: [], talking: [] };
    }
  }

  // Current animation state
  let currentFolder: string = "";
  let currentFrame: number = 0;
  let animationTimer: number | null = null;
  let rafHandle: number | null = null;
  let lastFrameTime: number = 0;
  let backgroundLoadHandle: number | null = null;
  let backgroundLoading: boolean = false;
  let backgroundStartTimer: number | null = null;

  function workerCall(payload: Record<string, unknown>, transfer?: Transferable[]): Promise<void> {
    if (!renderWorker) return Promise.reject(new Error("Worker not available"));
    const id = ++workerRequestSeq;
    return new Promise((resolve, reject) => {
      workerPending.set(id, { resolve, reject });
      renderWorker!.postMessage({ ...payload, id }, transfer ?? []);
    });
  }

  function setupWorkerIfPossible(): void {
    // Worker renderer disabled - video elements can't be transferred to workers
    // We render directly from video elements in the main thread
    renderWorker = null;
    usingWorkerRenderer = false;
    logDebug("🎥 Using direct video rendering");

    if (!renderWorker) return;

    renderWorker.onmessage = (ev) => {
      const msg = ev.data || {};
      const id = msg.id;
      const pending = workerPending.get(id);
      if (!pending) return;
      workerPending.delete(id);
      if (msg.type === "error") pending.reject(new Error(msg.error || "worker error"));
      else pending.resolve();
    };

    renderWorker.onerror = (err) => {
      logWarn("⚠️ Avatar render worker error:", err);
      recoverFromWorkerFailure("worker error", err);
    };

    try {
      const offscreen = (canvas as unknown as HTMLCanvasElement).transferControlToOffscreen();
      canvasTransferredToOffscreen = true;
      void workerCall(
        {
          type: "init",
          canvas: offscreen,
          initialState: currentState,
          initialStatus: currentStatus,
          frameInterval: Math.round(1000 / WORKER_FRAME_RATE),
        },
        [offscreen as unknown as Transferable]
      ).catch((e) => {
        logWarn("⚠️ Failed to init render worker:", e);
        recoverFromWorkerFailure("init failed", e);
      });
    } catch (e) {
      logWarn("⚠️ OffscreenCanvas init failed:", e);
      recoverFromWorkerFailure("offscreen init threw", e);
    }
  }

  function scheduleIdleWork(work: (deadline?: IdleDeadline) => void): number {
    const w = window as unknown as {
      requestIdleCallback?: (cb: (deadline: IdleDeadline) => void, opts?: { timeout: number }) => number;
    };
    if (typeof w.requestIdleCallback === "function") {
      return w.requestIdleCallback((deadline) => work(deadline)) as unknown as number;
    }
    return window.setTimeout(() => work(), 0) as unknown as number;
  }

  function cancelIdleWork(handle: number): void {
    const w = window as unknown as {
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof w.cancelIdleCallback === "function") {
      w.cancelIdleCallback(handle);
      return;
    }
    clearTimeout(handle);
  }

  const spriteLoader = createSpriteLoader({
    getSpriteRPC: () => spriteRPC,
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
    workerCall,
    getUsingWorkerRenderer: () => usingWorkerRenderer,
    getRenderWorker: () => renderWorker,
    getCurrentStatus: () => currentStatus,
    setCurrentStatus: (status) => { currentStatus = status; },
    getCurrentState: () => currentState,
    isLoaded: () => isLoadedFlag,
    setIsLoaded: (loaded) => { isLoadedFlag = loaded; },
    isAnimationActive: () => Boolean(animationTimer || rafHandle),
    decodedSprites,
    availableFolders,
    knownFolders,
    loadingFolders,
    getBackgroundLoading: () => backgroundLoading,
    setBackgroundLoading: (value) => { backgroundLoading = value; },
    getBackgroundLoadHandle: () => backgroundLoadHandle,
    setBackgroundLoadHandle: (handle) => { backgroundLoadHandle = handle; },
    getBackgroundStartTimer: () => backgroundStartTimer,
    setBackgroundStartTimer: (handle) => { backgroundStartTimer = handle; },
  });

  const {
    loadAnimatedSpriteForFolder,
    loadSpritesHybrid,
    reloadSprites,
  } = spriteLoader;

  /**
   * Get sprite data for current state
   */
  function getSpriteData(): { sprites: Record<string, DecodedSprite>; folders: string[] } {
    ensureStatusMaps(currentStatus);
    return {
      sprites: decodedSprites[currentStatus][currentState],
      folders: availableFolders[currentStatus][currentState],
    };
  }

  /**
   * Render current video frame to canvas
   */
  function renderVideoFrame(video: HTMLVideoElement, width: number, height: number): void {
    if (usingWorkerRenderer) return;
    const ctx2d = getCtx();

    // Resize canvas if needed
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    ctx2d.clearRect(0, 0, width, height);
    ctx2d.drawImage(video, 0, 0, width, height);

    if (!firstFrameRendered) {
      firstFrameRendered = true;
      logDebug(`🎬 First avatar frame rendered at +${Math.round(performance.now() - avatarInitAt)}ms`);
    }
  }

  function closeOverrideSprite(): void {
    if (!overrideSprite) return;
    try { overrideSprite.video.pause(); } catch { /* ignore */ }
    try { overrideSprite.video.remove(); } catch { /* ignore */ }
    try { URL.revokeObjectURL(overrideSprite.blobUrl); } catch { /* ignore */ }
    overrideSprite = null;
  }

  function getOverrideTtlMs(durationSec: number): number {
    const expectedMs = Math.ceil(durationSec * 1000) + OVERRIDE_TTL_BUFFER_MS;
    return Math.max(OVERRIDE_TTL_MS, expectedMs);
  }

  async function createOverrideVideoFromBase64(
    base64: string,
    metadata: VideoSprite["metadata"]
  ): Promise<VideoSprite | null> {
    return new Promise((resolve) => {
      try {
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.loop = false;
        video.preload = "auto";

        // Hide the video element
        video.style.position = "absolute";
        video.style.left = "-9999px";
        video.style.width = "1px";
        video.style.height = "1px";

        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: "video/webm" });
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
          resolve(sprite);
        };

        video.onerror = () => {
          logWarn(`   Video load error for override ${metadata.folder}`);
          URL.revokeObjectURL(blobUrl);
          resolve(null);
        };

        document.body.appendChild(video);
        video.load();
      } catch (e) {
        logWarn("   createOverrideVideoFromBase64 error:", e);
        resolve(null);
      }
    });
  }

  /**
   * Start animation loop for current state
   */
  function startAnimation(): void {
    if (usingWorkerRenderer) {
      if (workerRenderStarted || !renderWorker) return;
      workerRenderStarted = true;
      void workerCall({ type: "setState", state: currentState }).catch(() => {});
      void workerCall({ type: "start" }).catch(() => {});
      return;
    }
    if (animationTimer || rafHandle) return;

    // Choose initial sprite: override (one-shot) or normal base state
    if (overrideKey && overrideSprite) {
      overrideSprite.video.currentTime = 0;
      overrideSprite.video.play().catch(() => {});
      overrideStartedAt = performance.now();
      overrideTtlMs = getOverrideTtlMs(overrideSprite.duration);
      logDebug(`▶️ Starting override/${overrideKey} one-shot (${overrideSprite.duration.toFixed(2)}s)`);
    } else {
      const { sprites, folders } = getSpriteData();
      if (folders.length === 0) {
        logWarn(`⚠️ No animation folders for state: ${currentState}`);
        return;
      }

      // Pick random folder
      currentFolder = folders[Math.floor(Math.random() * folders.length)];

      const sprite = sprites[currentFolder];
      if (!sprite || !sprite.video) {
        logWarn(`⚠️ No video sprite for ${currentState}/${currentFolder}`);
        return;
      }

      // Start playing the video
      sprite.video.currentTime = 0;
      sprite.video.play().catch(() => {});

      logDebug(`▶️ Starting ${currentState} animation with folder ${currentFolder} (${sprite.duration.toFixed(2)}s)`);
    }

    lastFrameTime = performance.now();

    const animate = (now: number): void => {
      rafHandle = window.requestAnimationFrame(animate) as unknown as number;

      if (now - lastFrameTime < FRAME_INTERVAL) return;
      lastFrameTime = now;

      // Override mode: play exactly once, then revert to base state animation
      if (overrideKey && overrideSprite) {
        // TTL safety
        if (now - overrideStartedAt > overrideTtlMs) {
          logWarn(`⚠️ Override TTL exceeded for ${overrideKey}, clearing`);
          closeOverrideSprite();
          overrideKey = null;
          stopAnimation();
          startAnimation();
          return;
        }

        renderVideoFrame(overrideSprite.video, overrideSprite.width, overrideSprite.height);

        if (
          overrideSprite.video.ended ||
          overrideSprite.video.currentTime >= Math.max(0, overrideSprite.duration - OVERRIDE_END_BUFFER_S)
        ) {
          logDebug(`🎬 Override complete: ${overrideKey} → resuming ${currentState}`);
          closeOverrideSprite();
          overrideKey = null;
          stopAnimation();
          startAnimation();
        }
        return;
      }

      const { sprites: currentSprites, folders: currentFolders } = getSpriteData();
      const currentSprite = currentSprites[currentFolder];
      if (!currentSprite || !currentSprite.video) return;

      // Render current video frame
      renderVideoFrame(currentSprite.video, currentSprite.width, currentSprite.height);

      // Check if video ended (or close to end) - switch to random folder
      if (currentSprite.video.ended || currentSprite.video.currentTime >= currentSprite.duration - 0.1) {
        const previousFolder = currentFolder;
        currentFolder = currentFolders[Math.floor(Math.random() * currentFolders.length)];

        // Pause old video, start new one
        currentSprite.video.pause();

        const newSprite = currentSprites[currentFolder];
        if (newSprite && newSprite.video) {
          newSprite.video.currentTime = 0;
          newSprite.video.play().catch(() => {});
        }

        logDebug(`🎬 Animation cycle: ${currentState} folder ${previousFolder} → ${currentFolder}`);
      }
    };

    rafHandle = window.requestAnimationFrame(animate) as unknown as number;
  }

  /**
   * Stop animation
   */
  function stopAnimation(): void {
    if (usingWorkerRenderer) {
      workerRenderStarted = false;
      void workerCall({ type: "stop" }).catch(() => {});
      return;
    }
    if (animationTimer) {
      clearTimeout(animationTimer);
      animationTimer = null;
    }
    if (rafHandle) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
  }

  /**
   * Update the status indicator element
   */
  function updateStatusIndicator(state: AvatarState): void {
    const indicator = document.getElementById("status-indicator");
    if (!indicator) return;

    const iconEl = indicator.querySelector(".status-icon");
    const textEl = indicator.querySelector(".status-text");

    indicator.classList.remove("status-idle", "status-processing", "status-talking");
    indicator.classList.add(`status-${state}`);

    if (iconEl && textEl) {
      switch (state) {
        case "idle":
          iconEl.textContent = "💤";
          textEl.textContent = "Idle";
          break;
        case "processing":
          iconEl.textContent = "🔍";
          textEl.textContent = "Researching...";
          break;
        case "talking":
          iconEl.textContent = "💬";
          textEl.textContent = "Talking";
          break;
      }
    }
  }

  /**
   * Set avatar state
   */
  function setState(state: AvatarState): void {
    const previousState = currentState;
    const overrideActive = Boolean(overrideKey && overrideSprite);
    if (!overrideActive) {
      stopAnimation();
    }
    currentState = state;

    logDebug(`🎭 Avatar state: ${previousState} → ${state}`);

    element.classList.remove("avatar-state-idle", "avatar-state-processing", "avatar-state-talking");
    element.classList.add(`avatar-state-${state}`);
    updateStatusIndicator(state);

    if (isLoadedFlag) {
      ensureStatusMaps(currentStatus);
      if (availableFolders[currentStatus][state].length === 0 && knownFolders[currentStatus][state].length > 0) {
        const folder = knownFolders[currentStatus][state][0];
        logDebug(`⚡ On-demand sprite load for ${currentStatus}/${state}/${folder}`);
        void loadAnimatedSpriteForFolder(currentStatus, state, folder).catch((err) => {
          logWarn(`⚠️ On-demand sprite load failed for ${currentStatus}/${state}/${folder}:`, err);
        });
      }
      if (usingWorkerRenderer && renderWorker) {
        void workerCall({ type: "setState", state }).catch(() => {});
      }
      if (!overrideActive) {
        startAnimation();
      }
    }
  }

  function setStatus(status: AvatarStatus): void {
    const nextStatus = status && status.trim().length > 0 ? status.trim() : DEFAULT_AVATAR_STATUS;
    if (nextStatus === currentStatus) return;

    const previousStatus = currentStatus;
    const overrideActive = Boolean(overrideKey && overrideSprite);
    if (!overrideActive) {
      stopAnimation();
    }
    currentStatus = nextStatus;
    ensureStatusMaps(currentStatus);

    element.classList.remove(`avatar-status-${previousStatus}`);
    element.classList.add(`avatar-status-${currentStatus}`);
    logDebug(`🎭 Avatar status: ${previousStatus} → ${currentStatus}`);

    if (usingWorkerRenderer && renderWorker) {
      void workerCall({ type: "setAvatarStatus", status: currentStatus }).catch(() => {});
    }

    if (backgroundLoadHandle) {
      cancelIdleWork(backgroundLoadHandle);
      backgroundLoadHandle = null;
    }
    if (backgroundStartTimer) {
      clearTimeout(backgroundStartTimer);
      backgroundStartTimer = null;
    }
    backgroundLoading = false;

    if (isLoadedFlag) {
      void loadSpritesHybrid();
    }
  }

  async function setOverrideStateKey(key: string): Promise<void> {
    const override = key?.toString().trim();
    if (!override) return;

    const rpc = spriteRPC;
    if (!rpc || typeof rpc.loadOverrideSpriteSheet !== "function") {
      logWarn("⚠️ Sprite RPC missing override loader");
      return;
    }

    try {
      logDebug(`🎭 Loading override/${override} one-shot...`);
      const result = await rpc.loadOverrideSpriteSheet({ key: override });
      const sprite = await createOverrideVideoFromBase64(result.base64, {
        status: "override",
        type: "idle",
        folder: result.metadata.key,
        sourceFile: result.metadata.sourceFile,
      });

      if (!sprite) {
        throw new Error(`Failed to create override video for ${override}`);
      }

      closeOverrideSprite();
      overrideKey = override;
      overrideSprite = sprite;
      overrideStartedAt = performance.now();
      overrideTtlMs = getOverrideTtlMs(sprite.duration);

      stopAnimation();
      startAnimation();
    } catch (error) {
      logError("Failed to play override:", error);
      throw error;
    }
  }

  function getState(): AvatarState {
    return currentState;
  }

  function getStatus(): AvatarStatus {
    return currentStatus;
  }

  function isLoaded(): boolean {
    return isLoadedFlag;
  }

  function destroy(): void {
    stopAnimation();
    closeOverrideSprite();

    if (backgroundLoadHandle) {
      cancelIdleWork(backgroundLoadHandle);
      backgroundLoadHandle = null;
    }
    if (backgroundStartTimer) {
      clearTimeout(backgroundStartTimer);
      backgroundStartTimer = null;
    }
    backgroundLoading = false;

    if (renderWorker) {
      try { renderWorker.terminate(); } catch { /* ignore */ }
      renderWorker = null;
    }
    rejectAllWorkerPending("Avatar destroyed");

    // Cleanup video elements
    for (const status of Object.keys(decodedSprites)) {
      for (const type of ["idle", "processing", "talking"] as AvatarState[]) {
        for (const sprite of Object.values(decodedSprites[status][type])) {
          sprite.video.pause();
          sprite.video.src = '';
          sprite.video.remove();
          URL.revokeObjectURL(sprite.blobUrl);
        }
      }
    }
  }

  // Initialize
  setTimeout(() => {
    element.classList.add(`avatar-status-${currentStatus}`);
    setupWorkerIfPossible();
    loadSpritesHybrid();
    updateStatusIndicator(currentState);
  }, 100);

  return {
    setState,
    setStatus,
    setOverrideStateKey,
    getState,
    getStatus,
    destroy,
    reloadSprites,
    isLoaded,
  };
}

// Legacy export for backwards compatibility
export class Avatar {
  private instance: AvatarInstance;

  constructor(elementId: string = "avatar-canvas") {
    this.instance = createAvatar(elementId);
  }

  setState(state: AvatarState): void {
    this.instance.setState(state);
  }

  setStatus(status: AvatarStatus): void {
    this.instance.setStatus(status);
  }

  setOverrideStateKey(key: string): Promise<void> {
    return this.instance.setOverrideStateKey(key);
  }

  getState(): AvatarState {
    return this.instance.getState();
  }

  getStatus(): AvatarStatus {
    return this.instance.getStatus();
  }

  reloadSprites(): Promise<void> {
    return this.instance.reloadSprites();
  }

  isLoaded(): boolean {
    return this.instance.isLoaded();
  }
}
