import { logInfo, logError } from "../../utils/logger";
import {
  getAllReminders,
  acknowledgeReminder,
  deleteReminder as deleteReminderService,
} from "../../services/reminders";

export function createRemindersHandlers() {
  return {
    /**
     * Get all reminders
     */
    getAllReminders: async () => {
      try {
        const reminders = getAllReminders();
        return {
          reminders: reminders.map((r) => ({
            id: r.id,
            content: r.content,
            dueAt: r.due_at,
            status: r.status,
            triggeredAt: r.triggered_at ?? null,
            deliveredAt: r.delivered_at ?? null,
            acknowledgedAt: r.acknowledged_at ?? null,
            triggerCount: r.trigger_count ?? 0,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
          })),
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] getAllReminders failed:", errorMessage);
        throw error;
      }
    },

    acknowledgeReminders: async ({ ids }: { ids: number[] }) => {
      try {
        let acknowledgedCount = 0;
        for (const id of ids) {
          if (acknowledgeReminder(id)) acknowledgedCount++;
        }
        return { success: true, acknowledgedCount };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] acknowledgeReminders failed:", errorMessage);
        throw error;
      }
    },

    /**
     * Delete a reminder
     */
    deleteReminder: async ({ id }: { id: number }) => {
      try {
        const success = deleteReminderService(id);
        logInfo(`[RPC] Deleted reminder: ${id}`);
        return { success };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] deleteReminder failed:", errorMessage);
        throw error;
      }
    },
  };
}
