/**
 * Error Types and Codes
 * Centralized error type definitions for the AI Secretary app
 */

export type ErrorSeverity = "info" | "warning" | "error" | "critical";

export interface AppError {
  /** Unique error code for categorization */
  code: string;
  /** Technical error message for logging */
  message: string;
  /** Error severity level */
  severity: ErrorSeverity;
  /** User-friendly message for UI display (optional) */
  userMessage?: string;
  /** Whether the error is recoverable (app can continue) */
  recoverable: boolean;
  /** Additional context for debugging */
  context?: Record<string, unknown>;
  /** Timestamp when the error occurred */
  timestamp: number;
}

/**
 * Error codes for categorization and handling
 */
export const ErrorCodes = {
  // Memory/Storage errors
  MEMORY_SAVE_FAILED: "MEMORY_SAVE_FAILED",
  MEMORY_LOAD_FAILED: "MEMORY_LOAD_FAILED",
  MEMORY_CLEAR_FAILED: "MEMORY_CLEAR_FAILED",

  // TTS errors
  TTS_INIT_FAILED: "TTS_INIT_FAILED",
  TTS_GENERATION_FAILED: "TTS_GENERATION_FAILED",
  TTS_CANCELLED: "TTS_CANCELLED",

  // Screenshot errors
  SCREENSHOT_FAILED: "SCREENSHOT_FAILED",
  SCREENSHOT_SAVE_FAILED: "SCREENSHOT_SAVE_FAILED",

  // AI backend errors
  OPENCODE_INIT_FAILED: "OPENCODE_INIT_FAILED",
  OPENCODE_QUERY_FAILED: "OPENCODE_QUERY_FAILED",
  OPENCODE_SESSION_FAILED: "OPENCODE_SESSION_FAILED",

  // Transcription errors
  TRANSCRIPTION_INIT_FAILED: "TRANSCRIPTION_INIT_FAILED",
  TRANSCRIPTION_FAILED: "TRANSCRIPTION_FAILED",

  // Microphone errors
  MICROPHONE_ACCESS_DENIED: "MICROPHONE_ACCESS_DENIED",
  MICROPHONE_START_FAILED: "MICROPHONE_START_FAILED",

  // Validation errors
  VALIDATION_FAILED: "VALIDATION_FAILED",
  PATH_INJECTION_ATTEMPT: "PATH_INJECTION_ATTEMPT",

  // Background task errors
  BACKGROUND_TASK_FAILED: "BACKGROUND_TASK_FAILED",
  UNHANDLED_REJECTION: "UNHANDLED_REJECTION",

  // General errors
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * User-friendly messages for common error codes
 * These are shown in the UI via toast notifications
 */
export const UserMessages: Partial<Record<ErrorCode, string>> = {
  [ErrorCodes.MEMORY_SAVE_FAILED]: "Failed to save conversation to memory",
  [ErrorCodes.TTS_INIT_FAILED]: "Voice synthesis is unavailable",
  [ErrorCodes.TTS_GENERATION_FAILED]: "Failed to generate voice response",
  [ErrorCodes.SCREENSHOT_FAILED]: "Failed to capture screenshot",
  [ErrorCodes.SCREENSHOT_SAVE_FAILED]: "Failed to save screenshot",
  [ErrorCodes.OPENCODE_INIT_FAILED]: "AI service connection failed",
  [ErrorCodes.OPENCODE_QUERY_FAILED]: "Failed to get AI response",
  [ErrorCodes.TRANSCRIPTION_INIT_FAILED]: "Speech recognition is unavailable",
  [ErrorCodes.TRANSCRIPTION_FAILED]: "Speech recognition error",
  [ErrorCodes.MICROPHONE_ACCESS_DENIED]: "Microphone access denied",
  [ErrorCodes.MICROPHONE_START_FAILED]: "Failed to start microphone",
  [ErrorCodes.VALIDATION_FAILED]: "Invalid input",
  [ErrorCodes.PATH_INJECTION_ATTEMPT]: "Invalid file path",
};
