/**
 * Toast Notification Component
 * Displays system messages as toast notifications at the bottom of the screen
 */

import { logDebug } from "../utils/logger";

export interface ToastInstance {
  show: (message: string, duration?: number) => void;
  hide: (id: string) => void;
  hideAll: () => void;
}

/**
 * Create a Toast instance
 */
export function createToast(containerId: string = "toast-container"): ToastInstance {
  let container = document.getElementById(containerId);

  if (!container) {
    container = document.createElement("div");
    container.id = containerId;
    document.body.appendChild(container);
  }

  let toastIdCounter = 0;

  /**
   * Show a toast notification
   */
  function show(message: string, duration: number = 4000): string {
    logDebug(`[Toast] Showing: "${message}"`);

    const id = `toast-${toastIdCounter++}`;
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.id = id;
    toast.textContent = message;

    container.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
      toast.classList.add("show");
    });

    // Auto-hide after duration
    if (duration > 0) {
      setTimeout(() => {
        hide(id);
      }, duration);
    }

    return id;
  }

  /**
   * Hide a specific toast
   */
  function hide(id: string): void {
    const toast = document.getElementById(id);
    if (toast) {
      toast.classList.remove("show");
      toast.classList.add("hide");
      setTimeout(() => {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 300); // Match animation duration
    }
  }

  /**
   * Hide all toasts
   */
  function hideAll(): void {
    const toasts = container.querySelectorAll(".toast");
    toasts.forEach((toast) => {
      const id = toast.id;
      if (id) {
        hide(id);
      }
    });
  }

  return {
    show,
    hide,
    hideAll,
  };
}

