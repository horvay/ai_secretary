import { describe, expect, test } from "bun:test";
import { filterDueReminders, isReminderEligibleForTrigger } from "./reminder-engine";

describe("reminder engine", () => {
  test("pending due reminder is eligible", () => {
    expect(isReminderEligibleForTrigger({ due_at: 100, status: "pending" }, 101)).toBe(true);
  });

  test("future reminder is not eligible", () => {
    expect(isReminderEligibleForTrigger({ due_at: 200, status: "pending" }, 101)).toBe(false);
  });

  test("triggered reminder retries after cooldown", () => {
    expect(isReminderEligibleForTrigger({ due_at: 100, status: "triggered", triggered_at: 50 }, 400)).toBe(true);
    expect(isReminderEligibleForTrigger({ due_at: 100, status: "triggered", triggered_at: 380 }, 400, 30)).toBe(false);
  });

  test("filterDueReminders keeps only eligible reminders", () => {
    const result = filterDueReminders([
      { due_at: 10, status: "pending" },
      { due_at: 999, status: "pending" },
      { due_at: 1, status: "completed" },
    ], 100);
    expect(result).toHaveLength(1);
  });
});
