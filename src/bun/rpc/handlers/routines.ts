import { logDebug, logInfo, logError } from "../../utils/logger";
import {
  getPendingRoutines,
  getAllRoutinesWithStatus,
  acknowledgeRoutineTrigger,
  completeRoutine as completeRoutineService,
  failRoutineTrigger,
  uncompleteRoutine as uncompleteRoutineService,
  snoozeRoutine as snoozeRoutineService,
  toggleRoutine as toggleRoutineService,
  deleteRoutine as deleteRoutineService,
  wasUserActiveRecently,
} from "../../services/routines";

export function createRoutinesHandlers() {
  return {
    /**
     * Get all pending (due) routines
     */
    getPendingRoutines: async () => {
      try {
        const routines = getPendingRoutines();
        return {
          routines: routines.map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            scheduleType: r.schedule_type,
            scheduleValue: r.schedule_value,
          })),
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] getPendingRoutines failed:", errorMessage);
        throw error;
      }
    },

    /**
     * Get all routines with their current status
     */
    getAllRoutines: async () => {
      try {
        const routinesWithStatus = getAllRoutinesWithStatus();
        return {
          routines: routinesWithStatus.map((rs) => ({
            id: rs.routine.id,
            name: rs.routine.name,
            description: rs.routine.description,
            scheduleType: rs.routine.schedule_type,
            scheduleValue: rs.routine.schedule_value,
            enabled: rs.routine.enabled === 1,
            isDue: rs.isDue,
            isCompleted: rs.isCompleted,
            isSnoozed: rs.isSnoozed,
            completionsToday: rs.completionsToday,
            completionsThisWeek: rs.completionsThisWeek,
            snoozedUntilFormatted: rs.snoozedUntilFormatted,
          })),
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] getAllRoutines failed:", errorMessage);
        throw error;
      }
    },

    /**
     * Mark a routine as completed
     */
    completeRoutine: async ({ id }: { id: number }) => {
      try {
        const { getRoutineById } = await import("../../services/routines");
        const routine = getRoutineById(id);
        if (!routine) {
          throw new Error(`Routine with ID ${id} not found`);
        }
        completeRoutineService(id);
        logInfo(`[RPC] Completed routine: ${routine.name}`);
        return { success: true, name: routine.name };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] completeRoutine failed:", errorMessage);
        throw error;
      }
    },

    /**
     * Undo (un-complete) a routine for the current period
     */
    uncompleteRoutine: async ({ id }: { id: number }) => {
      try {
        const { getRoutineById } = await import("../../services/routines");
        const routine = getRoutineById(id);
        if (!routine) {
          throw new Error(`Routine with ID ${id} not found`);
        }

        const removed = uncompleteRoutineService(id);
        if (!removed) {
          return { success: false, name: routine.name };
        }

        logInfo(`[RPC] Uncompleted routine: ${routine.name}`);
        return { success: true, name: routine.name };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] uncompleteRoutine failed:", errorMessage);
        throw error;
      }
    },

    /**
     * Snooze a routine for the current period
     */
    snoozeRoutine: async ({ id, duration }: { id: number; duration: string }) => {
      try {
        const { getRoutineById } = await import("../../services/routines");
        const routine = getRoutineById(id);
        if (!routine) {
          throw new Error(`Routine with ID ${id} not found`);
        }

        const snoozed = snoozeRoutineService(id, duration);
        if (!snoozed || !snoozed.snoozed_until) {
          return { success: false, name: routine.name, snoozedUntil: "" };
        }

        const snoozedUntil = new Date(snoozed.snoozed_until * 1000).toLocaleString();
        logInfo(`[RPC] Snoozed routine: ${routine.name}`);
        return { success: true, name: routine.name, snoozedUntil };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] snoozeRoutine failed:", errorMessage);
        throw error;
      }
    },

    /**
     * Toggle a routine's enabled state
     */
    toggleRoutine: async ({ id }: { id: number }) => {
      try {
        const { getRoutineById } = await import("../../services/routines");
        const routine = getRoutineById(id);
        if (!routine) {
          throw new Error(`Routine with ID ${id} not found`);
        }

        const updated = toggleRoutineService(id);
        if (!updated) {
          return { success: false, name: routine.name, enabled: routine.enabled === 1 };
        }
        logInfo(`[RPC] Toggled routine: ${routine.name} -> ${updated.enabled ? "enabled" : "disabled"}`);
        return { success: true, name: routine.name, enabled: updated.enabled === 1 };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] toggleRoutine failed:", errorMessage);
        throw error;
      }
    },

    /**
     * Delete a routine
     */
    deleteRoutine: async ({ id }: { id: number }) => {
      try {
        const { getRoutineById } = await import("../../services/routines");
        const routine = getRoutineById(id);
        if (!routine) {
          throw new Error(`Routine with ID ${id} not found`);
        }
        const success = deleteRoutineService(id);
        logInfo(`[RPC] Deleted routine: ${routine.name}`);
        return { success, name: routine.name };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] deleteRoutine failed:", errorMessage);
        throw error;
      }
    },

    /**
     * Check if there are pending routine reminders to trigger
     * Returns the list of pending routine names if user was recently active
     */
    checkRoutineReminders: async () => {
      try {
        // Check if user was active in the last hour
        if (!wasUserActiveRecently()) {
          logDebug("[RPC] No recent voice activity, skipping routine reminders");
          return { hasPending: false, routineNames: [] };
        }

        const pending = getPendingRoutines();
        if (pending.length === 0) {
          logDebug("[RPC] No pending routines");
          return { hasPending: false, routineNames: [] };
        }

        const routineNames = pending.map((r) => r.name);
        logInfo(`[RPC] Found ${pending.length} pending routine(s): ${routineNames.join(", ")}`);
        return { hasPending: true, routineNames };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] checkRoutineReminders failed:", errorMessage);
        throw error;
      }
    },

    acknowledgeRoutineTriggers: async ({ ids }: { ids: number[] }) => {
      let acknowledgedCount = 0;
      for (const id of ids) {
        if (acknowledgeRoutineTrigger(id)) acknowledgedCount++;
      }
      return { success: true, acknowledgedCount };
    },

    failRoutineTriggers: async ({ ids }: { ids: number[] }) => {
      let failedCount = 0;
      for (const id of ids) {
        if (failRoutineTrigger(id)) failedCount++;
      }
      return { success: true, failedCount };
    },
  };
}
