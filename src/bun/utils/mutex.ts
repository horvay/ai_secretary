/**
 * Async Mutex Utility
 * Simple mutex for serializing async operations
 */

import { logDebug } from "./logger";

export interface Mutex {
  /**
   * Acquire the mutex lock
   * If already locked, waits until the lock is released
   */
  acquire(): Promise<void>;

  /**
   * Release the mutex lock
   * Allows the next waiting operation to proceed
   */
  release(): void;

  /**
   * Execute a function while holding the lock
   * Automatically releases the lock when the function completes (or throws)
   */
  withLock<T>(fn: () => Promise<T>): Promise<T>;

  /**
   * Check if the mutex is currently locked
   */
  isLocked(): boolean;

  /**
   * Get the number of operations waiting for the lock
   */
  getQueueLength(): number;
}

/**
 * Create a mutex instance for serializing async operations
 * @param name Optional name for debugging/logging
 */
export function createMutex(name?: string): Mutex {
  let locked = false;
  const queue: Array<() => void> = [];
  const mutexName = name ?? "mutex";

  return {
    async acquire(): Promise<void> {
      if (!locked) {
        locked = true;
        logDebug(`🔒 ${mutexName} acquired`);
        return;
      }

      logDebug(`⏳ ${mutexName}: waiting for lock (${queue.length + 1} queued)`);

      return new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    },

    release(): void {
      const next = queue.shift();
      if (next) {
        logDebug(`🔓 ${mutexName} released, passing to next (${queue.length} still queued)`);
        next();
      } else {
        locked = false;
        logDebug(`🔓 ${mutexName} released`);
      }
    },

    async withLock<T>(fn: () => Promise<T>): Promise<T> {
      await this.acquire();
      try {
        return await fn();
      } finally {
        this.release();
      }
    },

    isLocked(): boolean {
      return locked;
    },

    getQueueLength(): number {
      return queue.length;
    },
  };
}
