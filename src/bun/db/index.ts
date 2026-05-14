/**
 * Database module exports
 */

export {
  initDatabase,
  getDatabase,
  closeDatabase,
  getMemoryDir,
  getScreenshotsDir,
  getDailyDir,
  getUserProfilePath,
  type Interaction,
  type InteractionType,
  type InteractionRole,
  type InteractionKind,
  type InteractionModality,
  type ConversationSession,
  type ConversationTurn,
  type DailySummary,
  type Screenshot,
  type Routine,
  type RoutineCompletion,
  type ScheduleType,
  type AppState,
  type List,
  type ListItem,
  type Reminder,
  type ReminderStatus,
  type Task,
} from "./schema";

export { runMigrations, getMigrationStatus } from "./migrations";

