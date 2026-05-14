import { getDatabase } from "../../db";
import { createReminder } from "../../services/reminders";
import { createRoutine } from "../../services/routines";

type SmokeNames = {
  routineName: string;
  reminderContent: string;
};

function requireSmokeNames(payload: SmokeNames): SmokeNames {
  if (!payload?.routineName?.startsWith("SMOKE_ROUTINE_")) throw new Error("Invalid smoke routine name");
  if (!payload?.reminderContent?.startsWith("SMOKE_REMINDER_")) throw new Error("Invalid smoke reminder content");
  return payload;
}

export function createSmokeHandlers() {
  return {
    createSmokeRoutineAndReminder: async (payload: SmokeNames) => {
      const { routineName, reminderContent } = requireSmokeNames(payload);
      const db = getDatabase();
      db.query("DELETE FROM routines WHERE name = ?").run(routineName);
      db.query("DELETE FROM reminders WHERE content = ?").run(reminderContent);

      const routine = createRoutine({
        name: routineName,
        description: "Smoke test routine created by MCP same-run smoke.",
        scheduleType: "daily",
      });
      const reminder = createReminder({
        content: reminderContent,
        dueAt: Math.floor(Date.now() / 1000) + 3600,
      });
      return { routine: { id: routine.id, name: routine.name }, reminder: { id: reminder.id, content: reminder.content } };
    },

    readSmokeRoutineReminderState: async (payload: SmokeNames) => {
      const { routineName, reminderContent } = requireSmokeNames(payload);
      const db = getDatabase();
      const routines = db.query("SELECT id, name, enabled FROM routines WHERE name = ? ORDER BY id").all(routineName);
      const reminders = db.query("SELECT id, content, status FROM reminders WHERE content = ? ORDER BY id").all(reminderContent);
      return { routines, reminders };
    },

    cleanupSmokeRoutineAndReminder: async (payload: SmokeNames) => {
      const { routineName, reminderContent } = requireSmokeNames(payload);
      const db = getDatabase();
      const routineResult = db.query("DELETE FROM routines WHERE name = ?").run(routineName);
      const reminderResult = db.query("DELETE FROM reminders WHERE content = ?").run(reminderContent);
      return { deletedRoutines: routineResult.changes, deletedReminders: reminderResult.changes };
    },
  };
}
