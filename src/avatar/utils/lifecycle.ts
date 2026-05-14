/**
 * Lifecycle Manager
 * Tracks and manages cleanup of resources: timeouts, intervals, event listeners
 * Prevents memory leaks by ensuring all resources are properly cleaned up
 */

import { logDebug } from "./logger";

export interface LifecycleManager {
  /**
   * Set a timeout that will be automatically cleaned up
   */
  setTimeout(callback: () => void, ms: number): number;

  /**
   * Clear a tracked timeout
   */
  clearTimeout(id: number): void;

  /**
   * Add an event listener that will be automatically removed on cleanup
   */
  addEventListener<K extends keyof WindowEventMap>(
    target: EventTarget,
    type: K,
    listener: (ev: WindowEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions
  ): void;

  /**
   * Add a generic event listener
   */
  addEventListenerGeneric(
    target: EventTarget,
    type: string,
    listener: EventListener,
    options?: boolean | AddEventListenerOptions
  ): void;

  /**
   * Set an interval that will be automatically cleaned up
   */
  setInterval(callback: () => void, ms: number): number;

  /**
   * Clear a tracked interval
   */
  clearInterval(id: number): void;

  /**
   * Track an AudioContext for cleanup
   */
  trackAudioContext(context: AudioContext): void;

  /**
   * Track an AbortController for cleanup
   */
  trackAbortController(controller: AbortController): void;

  /**
   * Track a cleanup function to be called during cleanup
   */
  onCleanup(fn: () => void | Promise<void>): void;

  /**
   * Cleanup all tracked resources
   */
  cleanup(): Promise<void>;

  /**
   * Get statistics about tracked resources
   */
  getStats(): {
    timeouts: number;
    intervals: number;
    listeners: number;
    audioContexts: number;
    abortControllers: number;
    cleanupFunctions: number;
  };
}

interface TrackedListener {
  target: EventTarget;
  type: string;
  listener: EventListener;
  options?: boolean | AddEventListenerOptions;
}

/**
 * Create a lifecycle manager instance
 */
export function createLifecycleManager(): LifecycleManager {
  const timeouts = new Set<number>();
  const intervals = new Set<number>();
  const listeners: TrackedListener[] = [];
  const audioContexts: AudioContext[] = [];
  const abortControllers: AbortController[] = [];
  const cleanupFunctions: Array<() => void | Promise<void>> = [];

  return {
    setTimeout(callback, ms) {
      const id = window.setTimeout(() => {
        timeouts.delete(id);
        callback();
      }, ms);
      timeouts.add(id);
      return id;
    },

    clearTimeout(id) {
      window.clearTimeout(id);
      timeouts.delete(id);
    },

    addEventListener(target, type, listener, options) {
      target.addEventListener(type, listener as EventListener, options);
      listeners.push({
        target,
        type,
        listener: listener as EventListener,
        options,
      });
    },

    addEventListenerGeneric(target, type, listener, options) {
      target.addEventListener(type, listener, options);
      listeners.push({ target, type, listener, options });
    },

    setInterval(callback, ms) {
      const id = window.setInterval(callback, ms);
      intervals.add(id);
      return id;
    },

    clearInterval(id) {
      window.clearInterval(id);
      intervals.delete(id);
    },

    trackAudioContext(context) {
      audioContexts.push(context);
    },

    trackAbortController(controller) {
      abortControllers.push(controller);
    },

    onCleanup(fn) {
      cleanupFunctions.push(fn);
    },

    async cleanup() {
      logDebug(`🧹 Lifecycle cleanup starting...`);

      // Clear all timeouts
      timeouts.forEach((id) => window.clearTimeout(id));
      const timeoutCount = timeouts.size;
      timeouts.clear();

      // Clear all intervals
      intervals.forEach((id) => window.clearInterval(id));
      const intervalCount = intervals.size;
      intervals.clear();

      // Remove all event listeners
      const listenerCount = listeners.length;
      for (const { target, type, listener, options } of listeners) {
        try {
          target.removeEventListener(type, listener, options);
        } catch (err) {
          logDebug(`Failed to remove listener: ${err}`);
        }
      }
      listeners.length = 0;

      // Close all audio contexts
      const audioContextCount = audioContexts.length;
      for (const ctx of audioContexts) {
        try {
          if (ctx.state !== "closed") {
            await ctx.close();
          }
        } catch (err) {
          logDebug(`Failed to close AudioContext: ${err}`);
        }
      }
      audioContexts.length = 0;

      // Abort all controllers
      const abortCount = abortControllers.length;
      for (const controller of abortControllers) {
        try {
          if (!controller.signal.aborted) {
            controller.abort();
          }
        } catch (err) {
          logDebug(`Failed to abort controller: ${err}`);
        }
      }
      abortControllers.length = 0;

      // Run cleanup functions
      const cleanupCount = cleanupFunctions.length;
      for (const fn of cleanupFunctions) {
        try {
          await fn();
        } catch (err) {
          logDebug(`Cleanup function error: ${err}`);
        }
      }
      cleanupFunctions.length = 0;

      logDebug(
        `🧹 Lifecycle cleanup complete: ${timeoutCount} timeouts, ${intervalCount} intervals, ` +
          `${listenerCount} listeners, ${audioContextCount} audio contexts, ` +
          `${abortCount} abort controllers, ${cleanupCount} cleanup functions`
      );
    },

    getStats() {
      return {
        timeouts: timeouts.size,
        intervals: intervals.size,
        listeners: listeners.length,
        audioContexts: audioContexts.length,
        abortControllers: abortControllers.length,
        cleanupFunctions: cleanupFunctions.length,
      };
    },
  };
}

/**
 * Global lifecycle manager singleton for the application
 */
let _globalLifecycle: LifecycleManager | null = null;

export function getGlobalLifecycle(): LifecycleManager {
  if (!_globalLifecycle) {
    _globalLifecycle = createLifecycleManager();

    // Register cleanup on window unload
    window.addEventListener("beforeunload", () => {
      _globalLifecycle?.cleanup();
    });
  }
  return _globalLifecycle;
}
