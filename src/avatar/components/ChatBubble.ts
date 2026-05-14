/**
 * Chat Bubble Component
 * Functional module for displaying AI responses in a speech bubble
 */

import { logDebug, logWarn, logError, logInfo } from "../utils/logger";

export interface ChatBubbleInstance {
  show: (text: string) => void;
  append: (text: string) => void;
  showUserQuestion: (question: string) => void;
  hideUserQuestion: () => void;
  hide: () => void;
  isVisible: () => boolean;
  /** Show/hide the skip button (call when avatar state changes) */
  setSkipButtonVisible: (visible: boolean) => void;
  /** Set callback for when skip button is clicked */
  onSkip: (callback: () => void) => void;
}

/**
 * Create a ChatBubble instance with closure-based state
 */
export function createChatBubble(elementId: string = "chat-bubble"): ChatBubbleInstance {
  const element = document.getElementById(elementId);
  if (!element) {
    throw new Error(`Chat bubble element #${elementId} not found`);
  }

  // Get the user question label element
  const questionLabel = document.getElementById("user-question-label");
  if (!questionLabel) {
    logWarn("User question label element not found");
  }

  // Track if this is the first time showing (for animation)
  let wasHidden = element.classList.contains("hidden");

  // Ensure only one text element exists - remove any duplicates
  const existingTextElements = element.querySelectorAll(".bubble-text");
  if (existingTextElements.length > 1) {
    // Keep the first one, remove the rest
    for (let i = 1; i < existingTextElements.length; i++) {
      existingTextElements[i].remove();
    }
  }

  // Get or create the text element
  let textElement = element.querySelector(".bubble-text") as HTMLElement | null;
  if (!textElement) {
    textElement = document.createElement("div");
    textElement.className = "bubble-text";
    element.appendChild(textElement);
  }

  // Create skip button
  let skipButton = element.querySelector(".skip-button") as HTMLButtonElement | null;
  if (!skipButton) {
    skipButton = document.createElement("button");
    skipButton.className = "skip-button hidden";
    skipButton.title = "Stop Ari from speaking (Esc)";
    skipButton.innerHTML = "⏹️ Skip";
    skipButton.setAttribute("aria-label", "Skip response");
    element.appendChild(skipButton);
  }

  // Skip button callback
  let skipCallback: (() => void) | null = null;

  // Attach click handler to skip button
  skipButton.addEventListener("click", (e) => {
    e.stopPropagation();
    logInfo("🛑 Skip button clicked");
    if (skipCallback) {
      skipCallback();
    }
  });

  /**
   * Show chat bubble with text
   */
  function show(text: string): void {
    // Debug: log received text length
    logDebug(`[ChatBubble] show() called, text length: ${text.length}`);

    // Check for duplicate text elements (shouldn't happen, but defensive)
    const allTextElements = element.querySelectorAll(".bubble-text");
    if (allTextElements.length > 1) {
      logWarn(`ChatBubble: Found ${allTextElements.length} text elements, removing duplicates`);
      // Keep the first one, remove the rest
      for (let i = 1; i < allTextElements.length; i++) {
        allTextElements[i].remove();
      }
    }

    // Always get a fresh reference to the text element to avoid stale references
    let currentTextElement = element.querySelector(".bubble-text") as HTMLElement | null;
    if (!currentTextElement) {
      logWarn("ChatBubble: .bubble-text element not found, creating new one");
      currentTextElement = document.createElement("div");
      currentTextElement.className = "bubble-text";
      element.appendChild(currentTextElement);
    }

    // Debug: log before/after
    const beforeLength = currentTextElement.textContent?.length || 0;

    // Clear and set text content (textContent always replaces, never appends)
    currentTextElement.textContent = text;

    const afterLength = currentTextElement.textContent?.length || 0;
    if (afterLength !== text.length) {
      logError(`[ChatBubble] Text mismatch! Expected ${text.length}, got ${afterLength}`);
    }

    // Only trigger animation if transitioning from hidden to visible
    const isCurrentlyHidden = element.classList.contains("hidden");
    if (isCurrentlyHidden) {
      element.classList.remove("hidden");
      // Force reflow to ensure animation triggers
      void element.offsetWidth;
    }
  }

  /**
   * Append text to the chat bubble (streaming responses).
   */
  function append(text: string): void {
    if (!text) return;

    // Always get a fresh reference to the text element to avoid stale references
    let currentTextElement = element.querySelector(".bubble-text") as HTMLElement | null;
    if (!currentTextElement) {
      logWarn("ChatBubble: .bubble-text element not found, creating new one");
      currentTextElement = document.createElement("div");
      currentTextElement.className = "bubble-text";
      element.appendChild(currentTextElement);
    }

    const existing = currentTextElement.textContent ?? "";
    currentTextElement.textContent = existing + text;

    const isCurrentlyHidden = element.classList.contains("hidden");
    if (isCurrentlyHidden) {
      element.classList.remove("hidden");
      void element.offsetWidth;
    }
  }

  /**
   * Show user question label above the bubble
   */
  function showUserQuestion(question: string): void {
    if (!questionLabel) return;

    logDebug(`[ChatBubble] showUserQuestion() called: "${question.substring(0, 50)}..."`);

    // Set the question text (CSS ::before adds "You asked: " prefix)
    questionLabel.textContent = question;

    // Show the label
    const isCurrentlyHidden = questionLabel.classList.contains("hidden");
    if (isCurrentlyHidden) {
      questionLabel.classList.remove("hidden");
      // Force reflow to ensure animation triggers
      void questionLabel.offsetWidth;
    }
  }

  /**
   * Hide user question label
   */
  function hideUserQuestion(): void {
    if (!questionLabel) return;
    questionLabel.classList.add("hidden");
  }

  /**
   * Hide chat bubble and question label
   */
  function hide(): void {
    element.classList.add("hidden");
    hideUserQuestion();
  }

  /**
   * Check if visible
   */
  function isVisible(): boolean {
    return !element.classList.contains("hidden");
  }

  /**
   * Show or hide the skip button
   */
  function setSkipButtonVisible(visible: boolean): void {
    if (!skipButton) return;
    if (visible) {
      skipButton.classList.remove("hidden");
    } else {
      skipButton.classList.add("hidden");
    }
  }

  /**
   * Set callback for skip button click
   */
  function onSkipCallback(callback: () => void): void {
    skipCallback = callback;
  }

  return {
    show,
    append,
    showUserQuestion,
    hideUserQuestion,
    hide,
    isVisible,
    setSkipButtonVisible,
    onSkip: onSkipCallback,
  };
}

// Legacy export for backwards compatibility
export class ChatBubble {
  private instance: ChatBubbleInstance;

  constructor(elementId: string = "chat-bubble") {
    this.instance = createChatBubble(elementId);
  }

  show(text: string): void {
    this.instance.show(text);
  }

  showUserQuestion(question: string): void {
    this.instance.showUserQuestion(question);
  }

  hideUserQuestion(): void {
    this.instance.hideUserQuestion();
  }

  hide(): void {
    this.instance.hide();
  }

  isVisible(): boolean {
    return this.instance.isVisible();
  }

  setSkipButtonVisible(visible: boolean): void {
    this.instance.setSkipButtonVisible(visible);
  }

  onSkip(callback: () => void): void {
    this.instance.onSkip(callback);
  }
}
