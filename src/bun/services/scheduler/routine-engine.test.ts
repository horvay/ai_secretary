import { describe, expect, test } from "bun:test";
import { computeRoutinePeriodKey, filterTriggerableRoutines, isRoutineDueAt } from "./routine-engine";

describe("routine engine", () => {
  const now = new Date("2026-05-04T10:30:00");

  test("daily routine due when not completed today", () => {
    expect(isRoutineDueAt({ id: 1, schedule_type: "daily", enabled: 1, completionsToday: 0 }, now)).toBe(true);
    expect(isRoutineDueAt({ id: 1, schedule_type: "daily", enabled: 1, completionsToday: 1 }, now)).toBe(false);
  });

  test("specific time respects current time", () => {
    expect(isRoutineDueAt({ id: 2, schedule_type: "specific_time", schedule_value: "09:00", enabled: 1, completionsToday: 0 }, now)).toBe(true);
    expect(isRoutineDueAt({ id: 2, schedule_type: "specific_time", schedule_value: "11:00", enabled: 1, completionsToday: 0 }, now)).toBe(false);
  });

  test("weekly quota due until quota reached", () => {
    expect(isRoutineDueAt({ id: 3, schedule_type: "weekly_quota", schedule_value: "3", enabled: 1, completionsThisWeek: 2 }, now)).toBe(true);
    expect(isRoutineDueAt({ id: 3, schedule_type: "weekly_quota", schedule_value: "3", enabled: 1, completionsThisWeek: 3 }, now)).toBe(false);
  });

  test("interval routine due after interval passes", () => {
    expect(isRoutineDueAt({ id: 4, schedule_type: "interval", schedule_value: "4h", enabled: 1, lastCompletionAt: new Date("2026-05-04T05:00:00").getTime() }, now)).toBe(true);
    expect(isRoutineDueAt({ id: 4, schedule_type: "interval", schedule_value: "4h", enabled: 1, lastCompletionAt: new Date("2026-05-04T08:00:00").getTime() }, now)).toBe(false);
  });

  test("period key groups daily and weekly correctly", () => {
    expect(computeRoutinePeriodKey({ id: 10, schedule_type: "daily", enabled: 1 }, now)).toBe("2026-05-04");
    expect(computeRoutinePeriodKey({ id: 11, schedule_type: "weekly_quota", schedule_value: "2", enabled: 1 }, now)).toContain("2026-W");
  });

  test("filterTriggerableRoutines ignores already triggered routines", () => {
    const result = filterTriggerableRoutines([
      { id: 1, schedule_type: "daily", enabled: 1, completionsToday: 0, alreadyTriggered: false },
      { id: 2, schedule_type: "daily", enabled: 1, completionsToday: 0, alreadyTriggered: true },
    ], now);
    expect(result.map((routine) => routine.id)).toEqual([1]);
  });
});
