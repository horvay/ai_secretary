/**
 * Input Modal Component
 * Functional module for handling user input for questions
 */

export type OnSendCallback = (text: string, includeScreenshot: boolean, activeWindowOnly: boolean) => void;
export type OnCancelCallback = () => void;

export interface InputModalInstance {
  show: () => void;
  hide: () => void;
  isVisible: () => boolean;
  onSend: (callback: OnSendCallback) => void;
  onCancel: (callback: OnCancelCallback) => void;
}

/**
 * Create an InputModal instance with closure-based state
 */
export function createInputModal(elementId: string = "input-modal"): InputModalInstance {
  const element = document.getElementById(elementId);
  if (!element) {
    throw new Error(`Input modal element #${elementId} not found`);
  }

  const inputElement = document.getElementById("question-input") as HTMLInputElement;
  const sendButton = document.getElementById("send-btn") as HTMLButtonElement;
  const cancelButton = document.getElementById("cancel-btn") as HTMLButtonElement;
  const includeScreenshotCheckbox = document.getElementById("include-screenshot") as HTMLInputElement;
  const activeWindowOnlyCheckbox = document.getElementById("active-window-only") as HTMLInputElement;

  if (!inputElement || !sendButton || !cancelButton || !includeScreenshotCheckbox || !activeWindowOnlyCheckbox) {
    throw new Error("Input modal elements not found");
  }

  // Callback state
  let onSendCallback: OnSendCallback | undefined;
  let onCancelCallback: OnCancelCallback | undefined;

  // Setup event listeners
  sendButton.addEventListener("click", () => {
    const text = inputElement.value.trim();
    if (text) {
      const includeScreenshot = includeScreenshotCheckbox.checked;
      const activeWindowOnly = activeWindowOnlyCheckbox.checked;
      onSendCallback?.(text, includeScreenshot, activeWindowOnly);
      hide();
      inputElement.value = "";
      // Reset checkboxes
      includeScreenshotCheckbox.checked = false;
      activeWindowOnlyCheckbox.checked = false;
    }
  });

  // Enable/disable active window checkbox based on screenshot checkbox
  includeScreenshotCheckbox.addEventListener("change", () => {
    activeWindowOnlyCheckbox.disabled = !includeScreenshotCheckbox.checked;
    if (!includeScreenshotCheckbox.checked) {
      activeWindowOnlyCheckbox.checked = false;
    }
  });

  cancelButton.addEventListener("click", () => {
    onCancelCallback?.();
    hide();
    inputElement.value = "";
  });

  inputElement.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      sendButton.click();
    } else if (e.key === "Escape") {
      cancelButton.click();
    }
  });

  /**
   * Show modal
   */
  function show(): void {
    element.classList.remove("hidden");
    inputElement.focus();
    // Initialize active window checkbox state
    activeWindowOnlyCheckbox.disabled = !includeScreenshotCheckbox.checked;
  }

  /**
   * Hide modal
   */
  function hide(): void {
    element.classList.add("hidden");
    inputElement.blur();
  }

  /**
   * Check if visible
   */
  function isVisible(): boolean {
    return !element.classList.contains("hidden");
  }

  /**
   * Set send callback
   */
  function setOnSend(callback: OnSendCallback): void {
    onSendCallback = callback;
  }

  /**
   * Set cancel callback
   */
  function setOnCancel(callback: OnCancelCallback): void {
    onCancelCallback = callback;
  }

  return {
    show,
    hide,
    isVisible,
    onSend: setOnSend,
    onCancel: setOnCancel,
  };
}

// Legacy export for backwards compatibility
export class InputModal {
  private instance: InputModalInstance;

  constructor(elementId: string = "input-modal") {
    this.instance = createInputModal(elementId);
  }

  show(): void {
    this.instance.show();
  }  hide(): void {
    this.instance.hide();
  }  isVisible(): boolean {
    return this.instance.isVisible();
  }  onSend(callback: OnSendCallback): void {
    this.instance.onSend(callback);
  }  onCancel(callback: OnCancelCallback): void {
    this.instance.onCancel(callback);
  }
}
