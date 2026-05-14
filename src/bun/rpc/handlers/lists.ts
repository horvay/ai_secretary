import { logInfo, logError } from "../../utils/logger";
import {
  getAllListsWithCounts,
  getListItems,
  removeItem as removeListItemService,
  clearList as clearListService,
  deleteList as deleteListService,
} from "../../services/lists";

export function createListsHandlers() {
  return {
    /**
     * Get all lists with item counts
     */
    getAllLists: async () => {
      try {
        const lists = getAllListsWithCounts();
        return {
          lists: lists.map((l) => ({
            id: l.id,
            name: l.name,
            description: l.description,
            itemCount: l.item_count,
          })),
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] getAllLists failed:", errorMessage);
        throw error;
      }
    },

    /**
     * Get items for a specific list
     */
    getListItems: async ({ listId }: { listId: number }) => {
      try {
        const items = getListItems(listId);
        return {
          items: items.map((i) => ({
            id: i.id,
            listId: i.list_id,
            content: i.content,
            position: i.position,
          })),
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] getListItems failed:", errorMessage);
        throw error;
      }
    },

    /**
     * Remove an item from a list
     */
    removeListItem: async ({ itemId }: { itemId: number }) => {
      try {
        const success = removeListItemService(itemId);
        logInfo(`[RPC] Removed list item: ${itemId}`);
        return { success };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] removeListItem failed:", errorMessage);
        throw error;
      }
    },

    /**
     * Clear all items from a list
     */
    clearList: async ({ listId }: { listId: number }) => {
      try {
        const clearedCount = clearListService(listId);
        logInfo(`[RPC] Cleared ${clearedCount} items from list: ${listId}`);
        return { success: true, clearedCount };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] clearList failed:", errorMessage);
        throw error;
      }
    },

    /**
     * Delete an entire list
     */
    deleteList: async ({ listId }: { listId: number }) => {
      try {
        const success = deleteListService(listId);
        logInfo(`[RPC] Deleted list: ${listId}`);
        return { success };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError("[RPC] deleteList failed:", errorMessage);
        throw error;
      }
    },
  };
}
