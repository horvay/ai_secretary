/**
 * CLI Module
 * Command-line argument parsing for AI Secretary
 */

export interface CliArgs {
  waitSeconds?: number;
  chatMessage?: string;
  includeScreenshot?: boolean;
  activeWindowOnly?: boolean; // Capture only the active window (vs full screen)
  reconcileProfile?: boolean;
  checkReminders?: boolean;
  testSchedulerInterval?: number; // Interval in seconds
  openModal?: "history" | "current-session" | "routines" | "lists" | "transcripts" | "tasks" | "reminders";
  openSettings?: boolean;
  settingsScroll?: number; // Scroll offset to apply to the settings modal before screenshotting
  takeScreenshot?: string; // Output file path
  // Contextual conversation system testing
  injectContext?: string; // Context text to inject without AI response
  testSilent?: boolean; // Test silent response mode
  testInterruptSeconds?: number; // Test interrupt after N seconds of response
  testRapidQuestions?: string[]; // Fire multiple rapid user asks
  testInterruptThenChat?: {
    firstMessage: string;
    secondMessage: string;
    interruptAfterSeconds: number;
  };
  // Testing flags for code quality fixes
  testCleanup?: boolean; // Test lifecycle cleanup
  testAudioBuffer?: boolean; // Test rolling audio buffer
  testMicRace?: boolean; // Test microphone state machine
  testTtsFlood?: boolean; // Test TTS mutex under load
  testErrorHandling?: boolean; // Test error notifications
  testInputValidation?: boolean; // Test input validation
  testPathInjection?: boolean; // Test path security
  testFileRefs?: boolean; // Test file reference optimization
  testAsyncLogging?: boolean; // Test async logging
  agentBackend?: "pi" | "local-llama";
}

/**
 * Parse command-line arguments and environment variables
 */
export function parseCliArgs(): CliArgs {
  const args: CliArgs = {};

  // First check CLI args
  const argv = process.argv;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--agent-backend") {
      const nextArg = argv[i + 1];
      if (nextArg === "pi" || nextArg === "local-llama") {
        args.agentBackend = nextArg;
        process.env.AI_SECRETARY_AGENT_BACKEND = nextArg;
        i++;
      }
    }

    if (arg === "--local-llama") {
      args.agentBackend = "local-llama";
      process.env.AI_SECRETARY_AGENT_BACKEND = "local-llama";
    }

    if (arg === "--wait" || arg === "-w") {
      const nextArg = argv[i + 1];
      if (nextArg && !nextArg.startsWith("-")) {
        const parsed = parseFloat(nextArg);
        if (!isNaN(parsed)) {
          args.waitSeconds = parsed;
        }
        i++;
      }
    }

    if (arg === "--chat" || arg === "-c") {
      const nextArg = argv[i + 1];
      if (nextArg) {
        args.chatMessage = nextArg;
        i++;
      }
    }

    if (arg === "--screenshot" || arg === "-s") {
      args.includeScreenshot = true;
    }

    if (arg === "--active-window" || arg === "-a") {
      args.activeWindowOnly = true;
    }

    if (arg === "--reconcile-profile" || arg === "--daily-recon" || arg === "-r") {
      args.reconcileProfile = true;
    }

    if (arg === "--check-reminders") {
      args.checkReminders = true;
    }

    if (arg === "--test-scheduler") {
      const nextArg = argv[i + 1];
      if (nextArg && !nextArg.startsWith("-")) {
        const parsed = parseInt(nextArg, 10);
        args.testSchedulerInterval = !isNaN(parsed) ? parsed : 30;
        i++;
      } else {
        args.testSchedulerInterval = 30; // Default 30 seconds
      }
    }

    if (arg === "--open-modal" || arg === "--modal") {
      const nextArg = argv[i + 1];
      if (nextArg && ["history", "current-session", "routines", "lists", "transcripts", "tasks", "reminders"].includes(nextArg)) {
        args.openModal = nextArg as CliArgs["openModal"];
        i++;
      } else {
        // Default to routines if no valid value specified
        args.openModal = "routines";
      }
    }

    if (arg === "--open-settings") {
      args.openSettings = true;
    }

    if (arg === "--settings-scroll") {
      const nextArg = argv[i + 1];
      if (nextArg && !nextArg.startsWith("-")) {
        const parsed = parseInt(nextArg, 10);
        if (!isNaN(parsed)) {
          args.settingsScroll = parsed;
        }
        i++;
      }
    }

    if (arg === "--take-screenshot" || arg === "--snap") {
      const nextArg = argv[i + 1];
      if (nextArg && !nextArg.startsWith("-")) {
        args.takeScreenshot = nextArg;
        i++;
      } else {
        // Default filename with timestamp
        args.takeScreenshot = `screenshot-${Date.now()}.png`;
      }
    }

    // Test flags for code quality fixes
    if (arg === "--test-cleanup") {
      args.testCleanup = true;
    }
    if (arg === "--test-audio-buffer") {
      args.testAudioBuffer = true;
    }
    if (arg === "--test-mic-race") {
      args.testMicRace = true;
    }
    if (arg === "--test-tts-flood") {
      args.testTtsFlood = true;
    }
    if (arg === "--test-error-handling") {
      args.testErrorHandling = true;
    }
    if (arg === "--test-input-validation") {
      args.testInputValidation = true;
    }
    if (arg === "--test-path-injection") {
      args.testPathInjection = true;
    }
    if (arg === "--test-file-refs") {
      args.testFileRefs = true;
    }
    if (arg === "--test-async-logging") {
      args.testAsyncLogging = true;
    }
    if (arg === "--test-rapid-questions") {
      const values: string[] = [];
      let j = i + 1;
      while (j < argv.length && !argv[j].startsWith("-")) {
        values.push(argv[j]);
        j++;
      }
      if (values.length >= 2) {
        args.testRapidQuestions = values;
        i = j - 1;
      }
    }
    if (arg === "--test-interrupt-then-chat") {
      const first = argv[i + 1];
      const second = argv[i + 2];
      const delayRaw = argv[i + 3];
      const delay = delayRaw ? parseFloat(delayRaw) : NaN;
      if (first && second && !isNaN(delay) && delay > 0) {
        args.testInterruptThenChat = {
          firstMessage: first,
          secondMessage: second,
          interruptAfterSeconds: delay,
        };
        i += 3;
      }
    }

    if (arg === "--help" || arg === "-h") {
      console.log(`
AI Secretary CLI Options:
  --agent-backend <name>   Agent backend: pi|local-llama
  --local-llama            Shortcut for --agent-backend local-llama
  --wait, -w <seconds>     Wait before executing commands
  --chat, -c <message>     Chat message to send
  --screenshot, -s         Include screenshot with chat request
  --active-window, -a      Capture only active window (use with -s)
  --daily-recon, -r        Trigger daily summary & profile reconciliation
  --check-reminders        Immediately check and trigger routine reminders
  --test-scheduler [sec]   Enable scheduler test mode (default 30s, bypasses activity check)
  --open-modal <tab>       Open modal (history|current-session|routines|lists|transcripts|tasks|reminders)
  --open-settings          Open settings modal
  --settings-scroll <px>   Scroll the settings modal before screenshotting
  --take-screenshot <file> Take a screenshot and save to file
  --help, -h               Show this help message

Testing Flags:
  --test-cleanup           Test lifecycle cleanup
  --test-audio-buffer      Test rolling audio buffer
  --test-mic-race          Test microphone state machine
  --test-tts-flood         Test TTS mutex under load
  --test-error-handling    Test error notifications
  --test-input-validation  Test input validation
  --test-path-injection    Test path security
  --test-file-refs         Test file reference optimization
  --test-async-logging     Test async logging
  --test-rapid-questions <q1> <q2> [q3 ...]   Send rapid back-to-back messages
  --test-interrupt-then-chat <q1> <q2> <sec>  Interrupt q1 then send q2

Examples:
  ai-secretary --wait 3 --chat "look up the highest rated song"
  ai-secretary -w 5 -c "what's on my screen" -s
  ai-secretary --wait 2 --daily-recon
  ai-secretary --wait 3 --check-reminders
  ai-secretary --wait 4 --open-modal routines --take-screenshot routines.png
  ai-secretary --wait 4 --open-settings --settings-scroll 700 --take-screenshot settings-lower.png
  ai-secretary --test-rapid-questions "hello" "how are you"
  ai-secretary --test-interrupt-then-chat "tell me a long story" "short answer please" 2

Environment variables (alternative):
  AI_SECRETARY_WAIT=3 AI_SECRETARY_CHAT="look up the highest rated song" ai-secretary
      `);
      process.exit(0);
    }
  }

  // Also check environment variables as fallback
  const envWait = process.env.AI_SECRETARY_WAIT;
  const envChat = process.env.AI_SECRETARY_CHAT;
  const envScreenshot = process.env.AI_SECRETARY_SCREENSHOT;
  const envReconcileProfile = process.env.AI_SECRETARY_RECONCILE_PROFILE;
  const envCheckReminders = process.env.AI_SECRETARY_CHECK_REMINDERS;
  const envTestScheduler = process.env.AI_SECRETARY_TEST_SCHEDULER;
  const envOpenModal = process.env.AI_SECRETARY_OPEN_MODAL;
  const envOpenSettings = process.env.AI_SECRETARY_OPEN_SETTINGS;
  const envSettingsScroll = process.env.AI_SECRETARY_SETTINGS_SCROLL;
  const envTakeScreenshot = process.env.AI_SECRETARY_TAKE_SCREENSHOT;
  process.env.AI_SECRETARY_AGENT_BACKEND = "pi";

  if (envWait && !args.waitSeconds) {
    const parsed = parseFloat(envWait);
    if (!isNaN(parsed)) {
      args.waitSeconds = parsed;
    }
  }

  if (envChat && !args.chatMessage) {
    args.chatMessage = envChat;
  }

  if (envScreenshot === "1" || envScreenshot === "true") {
    args.includeScreenshot = true;
  }

  const envActiveWindow = process.env.AI_SECRETARY_ACTIVE_WINDOW;
  if (envActiveWindow === "1" || envActiveWindow === "true") {
    args.activeWindowOnly = true;
  }

  if (envReconcileProfile === "1" || envReconcileProfile === "true") {
    args.reconcileProfile = true;
  }

  if (envCheckReminders === "1" || envCheckReminders === "true") {
    args.checkReminders = true;
  }

  if (envTestScheduler) {
    const parsed = parseInt(envTestScheduler, 10);
    args.testSchedulerInterval = !isNaN(parsed) && parsed > 0 ? parsed : 30;
  }

  if (envOpenModal && !args.openModal) {
    if (["history", "current-session", "routines", "lists", "tasks", "reminders"].includes(envOpenModal)) {
      args.openModal = envOpenModal as CliArgs["openModal"];
    }
  }

  if (envOpenSettings === "1" || envOpenSettings === "true") {
    args.openSettings = true;
  }

  if (envSettingsScroll && args.settingsScroll == null) {
    const parsed = parseInt(envSettingsScroll, 10);
    if (!isNaN(parsed)) {
      args.settingsScroll = parsed;
    }
  }

  if (envTakeScreenshot && !args.takeScreenshot) {
    args.takeScreenshot = envTakeScreenshot;
  }

  // Contextual conversation system testing
  const envInjectContext = process.env.AI_SECRETARY_INJECT_CONTEXT;
  const envTestSilent = process.env.AI_SECRETARY_TEST_SILENT;
  const envTestRapidQuestions = process.env.AI_SECRETARY_TEST_RAPID_QUESTIONS;
  const envTestInterruptThenChat = process.env.AI_SECRETARY_TEST_INTERRUPT_THEN_CHAT;

  if (envInjectContext && !args.injectContext) {
    args.injectContext = envInjectContext;
  }

  if (envTestSilent === "1" || envTestSilent === "true") {
    args.testSilent = true;
  }

  if (envTestRapidQuestions && !args.testRapidQuestions) {
    try {
      const parsed = JSON.parse(envTestRapidQuestions);
      if (Array.isArray(parsed) && parsed.length >= 2 && parsed.every((v) => typeof v === "string")) {
        args.testRapidQuestions = parsed;
      }
    } catch {
      const split = envTestRapidQuestions
        .split("||")
        .map((v) => v.trim())
        .filter(Boolean);
      if (split.length >= 2) {
        args.testRapidQuestions = split;
      }
    }
  }

  if (envTestInterruptThenChat && !args.testInterruptThenChat) {
    try {
      const parsed = JSON.parse(envTestInterruptThenChat);
      if (
        parsed &&
        typeof parsed.firstMessage === "string" &&
        typeof parsed.secondMessage === "string" &&
        typeof parsed.interruptAfterSeconds === "number"
      ) {
        args.testInterruptThenChat = parsed;
      }
    } catch {
      // Ignore malformed override
    }
  }

  // Test interrupt
  const envTestInterrupt = process.env.AI_SECRETARY_TEST_INTERRUPT;
  if (envTestInterrupt) {
    const parsed = parseInt(envTestInterrupt, 10);
    if (!isNaN(parsed) && parsed > 0) {
      args.testInterruptSeconds = parsed;
    }
  }

  return args;
}

