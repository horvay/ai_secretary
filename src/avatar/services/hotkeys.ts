import type { AvatarInstance } from "../components/avatar/types";
import type { InputModalInstance } from "../components/InputModal";
import type { UnifiedSettingsModalInstance } from "../components/UnifiedSettingsModal";
import type { LifecycleManager } from "../utils/lifecycle";

export interface HotkeyDeps {
  lifecycle: LifecycleManager;
  inputModal: InputModalInstance;
  unifiedSettingsModal: UnifiedSettingsModalInstance;
  openSettings: () => Promise<void>;
  avatar: AvatarInstance;
  interruptAndResetUI: (reason: string) => Promise<void>;
  logInfo: (...args: unknown[]) => void;
}

/**
 * Setup global hotkeys - uses lifecycle manager for cleanup
 */
export function setupHotkeys({
  lifecycle,
  inputModal,
  unifiedSettingsModal,
  openSettings,
  avatar,
  interruptAndResetUI,
  logInfo,
}: HotkeyDeps): void {
  lifecycle.addEventListener(document, "keydown", (e) => {
    // Ctrl/Cmd + K to open input modal
    if ((e.ctrlKey || e.metaKey) && e.key === "k") {
      e.preventDefault();
      inputModal.show();
    }

    // Ctrl/Cmd + , to open settings modal
    if ((e.ctrlKey || e.metaKey) && e.key === ",") {
      e.preventDefault();
      void openSettings();
    }

    // Escape to close modal or interrupt response
    if (e.key === "Escape") {
      if (inputModal.isVisible()) {
        inputModal.hide();
      } else if (unifiedSettingsModal.isVisible()) {
        unifiedSettingsModal.hide();
      } else {
        // Check if avatar is actively responding
        const currentState = avatar.getState();
        if (currentState === "talking" || currentState === "processing") {
          logInfo("🛑 Escape pressed - interrupting response");
          void interruptAndResetUI("escape");
        }
      }
    }
  });
}
