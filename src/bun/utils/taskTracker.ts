/**
 * Background Task Tracker
 * Tracks long-running async operations for debugging and cleanup
 */

import { logDebug, logInfo, logError, logWarn } from "./logger";
import { createError, ErrorCodes } from "./errorHandler";

interface TrackedTask {
  id: string;
  name: string;
  promise: Promise<unknown>;
  startTime: number;
  cancelled: boolean;
}

// Active tasks map
const activeTasks = new Map<string, TrackedTask>();

// Task ID counter
let taskIdCounter = 0;

/**
 * Track a background task
 * Logs when the task starts, completes, or fails
 * @returns The wrapped promise
 */
export function trackTask<T>(name: string, promise: Promise<T>): Promise<T> {
  const id = `${name}-${++taskIdCounter}-${Date.now()}`;

  const task: TrackedTask = {
    id,
    name,
    promise,
    startTime: Date.now(),
    cancelled: false,
  };

  activeTasks.set(id, task);
  logDebug(`📋 Tracking task: ${name} (id: ${id})`);

  return promise
    .then((result) => {
      const duration = Date.now() - task.startTime;
      activeTasks.delete(id);

      if (!task.cancelled) {
        logDebug(`✅ Task completed: ${name} (${duration}ms)`);
      }

      return result;
    })
    .catch((error) => {
      const duration = Date.now() - task.startTime;
      activeTasks.delete(id);

      if (!task.cancelled) {
        logError(`❌ Background task "${name}" failed after ${duration}ms:`, error);

        // Report to error system
        createError(ErrorCodes.BACKGROUND_TASK_FAILED, `${name}: ${error instanceof Error ? error.message : String(error)}`, {
          severity: "error",
          recoverable: true,
          context: {
            taskName: name,
            taskId: id,
            duration,
          },
        });
      }

      throw error;
    });
}

/**
 * Track a task with a cancellation token
 * Returns an object with the promise and a cancel function
 */
export function trackTaskWithCancel<T>(
  name: string,
  executor: (signal: AbortSignal) => Promise<T>
): {
  promise: Promise<T>;
  cancel: () => void;
} {
  const controller = new AbortController();
  const id = `${name}-${++taskIdCounter}-${Date.now()}`;

  const promise = executor(controller.signal);

  const task: TrackedTask = {
    id,
    name,
    promise,
    startTime: Date.now(),
    cancelled: false,
  };

  activeTasks.set(id, task);
  logDebug(`📋 Tracking cancellable task: ${name} (id: ${id})`);

  const wrappedPromise = promise
    .then((result) => {
      const duration = Date.now() - task.startTime;
      activeTasks.delete(id);

      if (!task.cancelled) {
        logDebug(`✅ Task completed: ${name} (${duration}ms)`);
      }

      return result;
    })
    .catch((error) => {
      const duration = Date.now() - task.startTime;
      activeTasks.delete(id);

      if (!task.cancelled) {
        if (error.name === "AbortError") {
          logDebug(`⚠️ Task cancelled: ${name} (${duration}ms)`);
        } else {
          logError(`❌ Background task "${name}" failed after ${duration}ms:`, error);

          createError(ErrorCodes.BACKGROUND_TASK_FAILED, `${name}: ${error instanceof Error ? error.message : String(error)}`, {
            severity: "error",
            recoverable: true,
            context: {
              taskName: name,
              taskId: id,
              duration,
            },
          });
        }
      }

      throw error;
    });

  return {
    promise: wrappedPromise,
    cancel: () => {
      const t = activeTasks.get(id);
      if (t) {
        t.cancelled = true;
        controller.abort();
      }
    },
  };
}

/**
 * Get the names of all currently active tasks
 */
export function getActiveTasks(): string[] {
  return Array.from(activeTasks.values()).map((t) => t.name);
}

/**
 * Get detailed info about all active tasks
 */
export function getActiveTasksInfo(): Array<{
  id: string;
  name: string;
  durationMs: number;
}> {
  const now = Date.now();
  return Array.from(activeTasks.values()).map((t) => ({
    id: t.id,
    name: t.name,
    durationMs: now - t.startTime,
  }));
}

/**
 * Cancel all active tasks
 */
export function cancelAllTasks(): void {
  const count = activeTasks.size;
  for (const task of activeTasks.values()) {
    task.cancelled = true;
  }
  activeTasks.clear();

  if (count > 0) {
    logWarn(`🛑 Cancelled ${count} active task(s)`);
  }
}
