export interface ReminderLike {
  due_at: number;
  status: string;
  triggered_at?: number | null;
}

export function isReminderEligibleForTrigger(
  reminder: ReminderLike,
  nowSec: number,
  retryDelaySec: number = 5 * 60,
) {
  if (reminder.due_at > nowSec) return false;
  if (reminder.status === "pending" || reminder.status === "failed") return true;
  if (reminder.status === "triggered") {
    return reminder.triggered_at == null || reminder.triggered_at <= nowSec - retryDelaySec;
  }
  return false;
}

export function filterDueReminders(
  reminders: ReminderLike[],
  nowSec: number,
  retryDelaySec: number = 5 * 60,
) {
  return reminders.filter((reminder) => isReminderEligibleForTrigger(reminder, nowSec, retryDelaySec));
}
