/**
 * Progress Modal Component
 * Displays progress for long-running operations like sprite processing
 */

export interface ProgressModalInstance {
  show: (title?: string) => void;
  hide: () => void;
  isVisible: () => boolean;
  updateProgress: (step: string, progress: number) => void;
  setComplete: (success: boolean, message: string) => void;
}

/**
 * Create the progress modal HTML and inject it into the DOM
 */
function createModalHTML(): HTMLElement {
  const modal = document.createElement("div");
  modal.id = "progress-modal";
  modal.className = "modal hidden";
  modal.innerHTML = `
    <div class="modal-content progress-modal-content">
      <div class="progress-header">
        <h2 id="progress-title">Processing...</h2>
      </div>

      <div class="progress-body">
        <div class="progress-bar-container">
          <div id="progress-bar" class="progress-bar"></div>
        </div>

        <div id="progress-step" class="progress-step">
          Initializing...
        </div>

        <div id="progress-percentage" class="progress-percentage">
          0%
        </div>
      </div>

      <div id="progress-result" class="progress-result hidden">
        <div id="progress-result-icon" class="result-icon"></div>
        <div id="progress-result-message" class="result-message"></div>
        <button id="progress-close-btn" class="action-btn primary">
          Close
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  return modal;
}

/**
 * Create a ProgressModal instance with closure-based state
 */
export function createProgressModal(): ProgressModalInstance {
  // Create modal if it doesn't exist
  let element = document.getElementById("progress-modal");
  if (!element) {
    element = createModalHTML();
  }

  const titleEl = document.getElementById("progress-title") as HTMLHeadingElement;
  const progressBar = document.getElementById("progress-bar") as HTMLDivElement;
  const stepEl = document.getElementById("progress-step") as HTMLDivElement;
  const percentageEl = document.getElementById("progress-percentage") as HTMLDivElement;
  const resultEl = document.getElementById("progress-result") as HTMLDivElement;
  const resultIconEl = document.getElementById("progress-result-icon") as HTMLDivElement;
  const resultMessageEl = document.getElementById("progress-result-message") as HTMLDivElement;
  const closeButton = document.getElementById("progress-close-btn") as HTMLButtonElement;

  // Setup close button
  closeButton.addEventListener("click", () => {
    hide();
  });

  /**
   * Show modal
   */
  function show(title: string = "Processing..."): void {
    // Reset state
    titleEl.textContent = title;
    progressBar.style.transform = "scaleX(0)";
    stepEl.textContent = "Initializing...";
    percentageEl.textContent = "0%";
    resultEl.classList.add("hidden");
    progressBar.parentElement!.classList.remove("hidden");
    stepEl.classList.remove("hidden");
    percentageEl.classList.remove("hidden");

    element!.classList.remove("hidden");
  }

  /**
   * Hide modal
   */
  function hide(): void {
    element!.classList.add("hidden");
  }

  /**
   * Check if visible
   */
  function isVisible(): boolean {
    return !element!.classList.contains("hidden");
  }

  /**
   * Update progress display
   */
  function updateProgress(step: string, progress: number): void {
    const clampedProgress = Math.max(0, Math.min(100, progress));

    progressBar.style.transform = `scaleX(${clampedProgress / 100})`;
    stepEl.textContent = step;
    percentageEl.textContent = `${Math.round(clampedProgress)}%`;
  }

  /**
   * Show completion state
   */
  function setComplete(success: boolean, message: string): void {
    // Hide progress elements
    progressBar.parentElement!.classList.add("hidden");
    stepEl.classList.add("hidden");
    percentageEl.classList.add("hidden");

    // Show result
    resultEl.classList.remove("hidden");
    resultIconEl.textContent = success ? "✅" : "❌";
    resultIconEl.className = `result-icon ${success ? "success" : "error"}`;
    resultMessageEl.textContent = message;

    // Update title
    titleEl.textContent = success ? "Complete!" : "Error";
  }

  return {
    show,
    hide,
    isVisible,
    updateProgress,
    setComplete,
  };
}

