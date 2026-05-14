import { logInfo, logError } from "../../utils/logger";
import {
  getAllTasks as getAllTasksService,
  createTask as createTaskService,
  completeTask as completeTaskService,
  cancelTask as cancelTaskService,
  deleteTask as deleteTaskService,
} from "../../services/tasks";

export function createTasksHandlers() {
  return {
    getAllTasks: async ({ status }: { status?: "open" | "completed" | "cancelled" }) => {
      try {
        const tasks = getAllTasksService({ status });
        return {
          tasks: tasks.map((task) => ({
            id: task.id,
            title: task.title,
            description: task.description,
            status: task.status,
            priority: task.priority,
            dueAt: task.due_at,
            reminderAt: task.reminder_at,
            listId: task.list_id,
            completedAt: task.completed_at,
            createdAt: task.created_at,
            updatedAt: task.updated_at,
          })),
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] getAllTasks failed:", errorMessage);
        throw error;
      }
    },

    createTask: async ({
      title,
      description,
      priority,
      dueAt,
      reminderAt,
      listId,
    }: {
      title: string;
      description?: string;
      priority?: "low" | "normal" | "high";
      dueAt?: number;
      reminderAt?: number;
      listId?: number;
    }) => {
      try {
        const task = createTaskService({ title, description, priority, dueAt, reminderAt, listId });
        logInfo(`[RPC] Created task: ${task.id} ${task.title}`);
        return { success: true, id: task.id };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] createTask failed:", errorMessage);
        throw error;
      }
    },

    completeTask: async ({ id }: { id: number }) => {
      try {
        const task = completeTaskService(id);
        return { success: task !== null };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] completeTask failed:", errorMessage);
        throw error;
      }
    },

    cancelTask: async ({ id }: { id: number }) => {
      try {
        const task = cancelTaskService(id);
        return { success: task !== null };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] cancelTask failed:", errorMessage);
        throw error;
      }
    },

    deleteTask: async ({ id }: { id: number }) => {
      try {
        const success = deleteTaskService(id);
        return { success };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] deleteTask failed:", errorMessage);
        throw error;
      }
    },
  };
}
