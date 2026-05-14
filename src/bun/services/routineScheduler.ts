/**
 * Routine Scheduler Service
 * Periodically checks for pending routines and triggers AI reminders
 */

import { logInfo, logDebug, logWarn } from "../utils/logger";
import { getPendingRoutines, wasUserActiveRecently, clearExpiredSnoozes, failRoutineTrigger, getAgenticRoutineSpec, hasTriggeredRoutineForCurrentPeriod, recordRoutineTrigger } from "./routines";
import { getPendingDueReminders, markReminderTriggered } from "./reminders";
import type { AppRpc } from "../types/app-rpc";

// Default check interval for routines: 1 hour (in milliseconds)
const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000;

// Check interval for one-time reminders: 1 minute
const REMINDER_CHECK_INTERVAL_MS = 60 * 1000;

// Minimum interval for routines: 5 minutes
const MIN_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// Scheduler state
let routineInterval: ReturnType<typeof setInterval> | null = null;
let reminderInterval: ReturnType<typeof setInterval> | null = null;
let isSchedulerRunning = false;
let checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS;
let testModeEnabled = false;

/**
 * RPC reference for sending messages to the webview
 */
let rpcRef: AppRpc | null = null;

/**
 * Set the RPC reference for the scheduler to use
 */
export function setSchedulerRpc(rpc: AppRpc): void {
  rpcRef = rpc;
  logDebug("[RoutineScheduler] RPC reference set");
}

/**
 * Configure the check interval
 * @param intervalMs - Interval in milliseconds (minimum 5 minutes)
 */
export function setCheckInterval(intervalMs: number): void {
  if (intervalMs < MIN_CHECK_INTERVAL_MS) {
    logWarn(
      `[RoutineScheduler] Interval ${intervalMs}ms is below minimum. Using ${MIN_CHECK_INTERVAL_MS}ms`
    );
    intervalMs = MIN_CHECK_INTERVAL_MS;
  }

  checkIntervalMs = intervalMs;
  logInfo(`[RoutineScheduler] Check interval set to ${intervalMs / 60000} minutes`);

  // If scheduler is running, restart with new interval
  if (isSchedulerRunning) {
    stopScheduler();
    startScheduler();
  }
}

/**
 * Enable test mode - short interval and bypasses activity check
 * @param intervalMs - Interval in milliseconds (default 30 seconds)
 */
export function enableTestMode(intervalMs: number = 30000): void {
  testModeEnabled = true;
  checkIntervalMs = Math.max(intervalMs, 1000); // Minimum 1 second in test mode
  logInfo(`[RoutineScheduler] 🧪 TEST MODE enabled - ${checkIntervalMs / 1000}s interval, activity check bypassed`);

  // Restart scheduler with new interval if running
  if (isSchedulerRunning) {
    stopScheduler();
    startScheduler();
  }
}

/**
 * Check if test mode is enabled
 */
export function isTestMode(): boolean {
  return testModeEnabled;
}

/**
 * Core function to check for and trigger one-time reminders
 * Runs every minute and bypasses the "user active recently" check
 */
async function checkAndTriggerOneTimeReminders(): Promise<void> {
  logDebug("[RoutineScheduler] Checking for pending one-time reminders...");

  const pendingReminders = getPendingDueReminders();
  if (pendingReminders.length === 0) {
    return;
  }

  const reminders = pendingReminders.map((r) => ({ id: r.id, content: r.content }));
  logInfo(`[RoutineScheduler] Found ${pendingReminders.length} pending reminder(s): ${reminders.map((r) => r.content).join(", ")}`);

  if (rpcRef) {
    try {
      rpcRef.send.triggerOneTimeReminders({ reminders });
      logInfo(`[RoutineScheduler] Triggered one-time reminders for: ${reminders.map((r) => r.content).join(", ")}`);

      // Mark them as triggered (not completed) so delivery is idempotent/retryable.
      for (const reminder of pendingReminders) {
        markReminderTriggered(reminder.id);
      }
    } catch (error) {
      logWarn("[RoutineScheduler] Failed to send one-time reminders:", error);
    }
  }
}

/**
 * Core function to check for and trigger recurring routines
 * Runs at the user-specified interval (default 1h) and respects activity check
 */
async function checkAndTriggerRoutines(options?: {
  bypassActivityCheck?: boolean;
}): Promise<void> {
  const bypassActivityCheck = options?.bypassActivityCheck ?? false;
  logDebug("[RoutineScheduler] Checking for pending recurring routines...");

  // Clear any expired snoozes first
  const expiredSnoozes = clearExpiredSnoozes();
  if (expiredSnoozes.length > 0) {
    logInfo(`[RoutineScheduler] Cleared ${expiredSnoozes.length} expired snooze(s): ${expiredSnoozes.map(r => r.name).join(", ")}`);
  }

  // Check activity (respect unless in test mode or startup)
  if (!testModeEnabled && !bypassActivityCheck && !wasUserActiveRecently()) {
    logDebug("[RoutineScheduler] No recent voice activity, skipping routines check");
    return;
  }

  const pendingRoutines = getPendingRoutines();
  const now = new Date();
  const untriggeredRoutines = pendingRoutines.filter((routine) => !hasTriggeredRoutineForCurrentPeriod(routine, now));
  if (untriggeredRoutines.length === 0) {
    return;
  }

  logInfo(`[RoutineScheduler] Found ${untriggeredRoutines.length} pending routine(s): ${untriggeredRoutines.map((routine) => routine.name).join(", ")}`);

  if (rpcRef) {
    const triggerRecords = untriggeredRoutines.map((routine) => ({
      routine,
      trigger: recordRoutineTrigger(routine, "pending", now),
    }));
    const routines = triggerRecords.map(({ routine, trigger }) => {
      const spec = getAgenticRoutineSpec(routine);
      const firstAskAction = spec.actionGraph?.actions.find((action) => action.type === "ask_ari");
      return {
        id: routine.id,
        name: routine.name,
        goal: spec.goal,
        prompt: firstAskAction?.type === "ask_ari" ? firstAskAction.prompt : spec.goal,
        triggerId: trigger.id,
        periodKey: trigger.periodKey,
      };
    });
    try {
      rpcRef.send.triggerRoutineReminder({ routines });
      logInfo(`[RoutineScheduler] Triggered routine reminder for: ${routines.map((routine) => routine.name).join(", ")}`);
    } catch (error) {
      logWarn("[RoutineScheduler] Failed to send routine reminders:", error);
      for (const { trigger } of triggerRecords) {
        failRoutineTrigger(trigger.id, now);
      }
    }
  }
}

/**
 * Check for pending routines and trigger reminder if needed
 * This is maintained for backward compatibility (CLI/RPC)
 */
export async function checkAndTriggerReminders(options?: {
  bypassActivityCheck?: boolean;
}): Promise<{
  triggered: boolean;
  routineNames: string[];
  reason?: string;
}> {
  const bypassActivityCheck = options?.bypassActivityCheck ?? false;

  const dueReminderNames = getPendingDueReminders().map((reminder) => reminder.content);
  const now = new Date();
  const dueRoutineNames = getPendingRoutines()
    .filter((routine) => !hasTriggeredRoutineForCurrentPeriod(routine, now))
    .map((routine) => routine.name);

  await checkAndTriggerOneTimeReminders();
  await checkAndTriggerRoutines({ bypassActivityCheck });

  const names = [...dueReminderNames, ...dueRoutineNames];
  return {
    triggered: names.length > 0,
    routineNames: names,
    reason: names.length > 0 ? undefined : "No pending reminders or routines",
  };
}

/**
 * Start the scheduler
 */
export function startScheduler(): void {
  if (isSchedulerRunning) {
    logDebug("[RoutineScheduler] Scheduler already running");
    return;
  }

  const routineIntervalDisplay = checkIntervalMs >= 60000
    ? `${checkIntervalMs / 60000} minute(s)`
    : `${checkIntervalMs / 1000} second(s)`;

  const testModeStr = testModeEnabled ? " 🧪 TEST MODE" : "";
  logInfo(`[RoutineScheduler] Starting scheduler: Routines (${routineIntervalDisplay}), One-time Reminders (1 minute)${testModeStr}`);

  // Start the routines interval
  routineInterval = setInterval(() => {
    checkAndTriggerRoutines().catch((error) => {
      logWarn("[RoutineScheduler] Error during scheduled routine check:", error);
    });
  }, checkIntervalMs);

  // Start the reminders interval
  reminderInterval = setInterval(() => {
    checkAndTriggerOneTimeReminders().catch((error) => {
      logWarn("[RoutineScheduler] Error during scheduled reminder check:", error);
    });
  }, REMINDER_CHECK_INTERVAL_MS);

  isSchedulerRunning = true;

  // Do initial checks after a short delay
  setTimeout(() => {
    logDebug("[RoutineScheduler] Running initial startup checks...");
    checkAndTriggerOneTimeReminders().catch(err => logWarn("[RoutineScheduler] Initial reminder check failed:", err));
    checkAndTriggerRoutines().catch(err => logWarn("[RoutineScheduler] Initial routine check failed:", err));
  }, 5000);
}

/**
 * Stop the scheduler
 */
export function stopScheduler(): void {
  if (!isSchedulerRunning) {
    logDebug("[RoutineScheduler] Scheduler not running");
    return;
  }

  if (routineInterval) {
    clearInterval(routineInterval);
    routineInterval = null;
  }

  if (reminderInterval) {
    clearInterval(reminderInterval);
    reminderInterval = null;
  }

  isSchedulerRunning = false;
  logInfo("[RoutineScheduler] Scheduler stopped");
}

/**
 * Check if scheduler is running
 */
export function isSchedulerActive(): boolean {
  return isSchedulerRunning;
}

/**
 * Get current check interval in milliseconds
 */
export function getCheckInterval(): number {
  return checkIntervalMs;
}

/**
 * Manually trigger a reminder check (for testing/CLI)
 */
export async function triggerManualCheck(): Promise<{
  triggered: boolean;
  routineNames: string[];
  reason?: string;
}> {
  logInfo("[RoutineScheduler] Manual check triggered");
  return checkAndTriggerReminders();
}

