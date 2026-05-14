import { currentTimeHm, isoWeekKey, localDateKey } from "./time";

export interface RoutineLike {
  id: number;
  schedule_type: "daily" | "specific_time" | "weekly_quota" | "interval";
  schedule_value?: string | null;
  schedule_config?: string | null;
  enabled: number;
  snoozed_until?: number | null;
  completionsToday?: number;
  completionsThisWeek?: number;
  lastCompletionAt?: number | null;
  alreadyTriggered?: boolean;
}

type ScheduleConfig =
  | { type: "daily" }
  | { type: "specific_time"; time: string }
  | { type: "weekly_quota"; count: number }
  | { type: "interval"; every: number; unit: "minutes" | "hours" | "days" };

function parseDurationMs(value: string) {
  const match = value.match(/^(\d+)([mhd])$/);
  if (!match) return 24 * 60 * 60 * 1000;
  const amount = Number.parseInt(match[1], 10);
  return match[2] === "m" ? amount * 60 * 1000 : match[2] === "d" ? amount * 24 * 60 * 60 * 1000 : amount * 60 * 60 * 1000;
}

function readConfig(routine: RoutineLike): ScheduleConfig {
  if (routine.schedule_config) {
    try {
      const parsed = JSON.parse(routine.schedule_config) as ScheduleConfig;
      if (parsed?.type) return parsed;
    } catch {}
  }

  switch (routine.schedule_type) {
    case "specific_time":
      return { type: "specific_time", time: routine.schedule_value ?? "09:00" };
    case "weekly_quota":
      return { type: "weekly_quota", count: Number.parseInt(routine.schedule_value ?? "1", 10) || 1 };
    case "interval": {
      const match = (routine.schedule_value ?? "24h").match(/^(\d+)([mhd])$/);
      const every = match ? Number.parseInt(match[1], 10) : 24;
      const unit = match?.[2] === "m" ? "minutes" : match?.[2] === "d" ? "days" : "hours";
      return { type: "interval", every, unit };
    }
    default:
      return { type: "daily" };
  }
}

export function computeRoutinePeriodKey(routine: RoutineLike, now: Date = new Date()) {
  const config = readConfig(routine);
  if (config.type === "weekly_quota") return isoWeekKey(now);
  if (config.type === "interval") {
    const duration = parseDurationMs(`${config.every}${config.unit === "minutes" ? "m" : config.unit === "days" ? "d" : "h"}`);
    return `interval:${routine.id}:${Math.floor(now.getTime() / duration)}`;
  }
  return localDateKey(now);
}

export function isRoutineDueAt(routine: RoutineLike, now: Date = new Date()) {
  if (routine.enabled === 0) return false;
  if (routine.snoozed_until && routine.snoozed_until > Math.floor(now.getTime() / 1000)) return false;
  if (routine.alreadyTriggered) return false;

  const config = readConfig(routine);
  if (config.type === "daily") {
    return (routine.completionsToday ?? 0) === 0;
  }
  if (config.type === "specific_time") {
    return (routine.completionsToday ?? 0) === 0 && currentTimeHm(now) >= config.time;
  }
  if (config.type === "weekly_quota") {
    return (routine.completionsThisWeek ?? 0) < config.count;
  }

  const duration = parseDurationMs(`${config.every}${config.unit === "minutes" ? "m" : config.unit === "days" ? "d" : "h"}`);
  if (!routine.lastCompletionAt) return true;
  return now.getTime() - routine.lastCompletionAt >= duration;
}

export function filterTriggerableRoutines(routines: RoutineLike[], now: Date = new Date()) {
  return routines.filter((routine) => isRoutineDueAt(routine, now));
}
