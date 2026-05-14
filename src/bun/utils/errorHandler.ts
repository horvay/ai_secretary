/**
 * Centralized Error Handler
 * Provides error reporting, notification, and tracking utilities
 */

import { logError, logWarn, logInfo, logDebug } from "./logger";
import { type AppError, type ErrorSeverity, type ErrorCode, ErrorCodes, UserMessages } from "../types/errors";

// Error handler callback type
type ErrorHandler = (error: AppError) => void;

// Registered error handlers
const errorHandlers: ErrorHandler[] = [];

/**
 * Subscribe to error events
 * @returns Unsubscribe function
 */
export function onError(handler: ErrorHandler): () => void {
  errorHandlers.push(handler);
  return () => {
    const idx = errorHandlers.indexOf(handler);
    if (idx >= 0) {
      errorHandlers.splice(idx, 1);
    }
  };
}

/**
 * Report an error to the error handling system
 * - Logs the error based on severity
 * - Notifies all registered handlers (for UI notifications, etc.)
 */
export function reportError(error: AppError): void {
  // Log based on severity
  const logFn =
    error.severity === "error" || error.severity === "critical"
      ? logError
      : error.severity === "warning"
        ? logWarn
        : error.severity === "info"
          ? logInfo
          : logDebug;

  logFn(`[${error.code}] ${error.message}`, error.context);

  // Notify all handlers
  for (const handler of errorHandlers) {
    try {
      handler(error);
    } catch (handlerError) {
      // Don't let handler errors break the error reporting system
      logWarn("Error handler threw:", handlerError);
    }
  }
}

/**
 * Create and report an error with standardized structure
 */
export function createError(
  code: ErrorCode,
  message: string,
  options: {
    severity?: ErrorSeverity;
    userMessage?: string;
    recoverable?: boolean;
    context?: Record<string, unknown>;
  } = {}
): AppError {
  const error: AppError = {
    code,
    message,
    severity: options.severity ?? "error",
    userMessage: options.userMessage ?? UserMessages[code],
    recoverable: options.recoverable ?? true,
    context: options.context,
    timestamp: Date.now(),
  };

  reportError(error);
  return error;
}

/**
 * Helper for common case: wrap an async operation with error reporting
 * Returns null if the operation fails (instead of throwing)
 */
export async function withErrorReporting<T>(
  code: ErrorCode,
  operation: () => Promise<T>,
  options: {
    userMessage?: string;
    severity?: ErrorSeverity;
    recoverable?: boolean;
    context?: Record<string, unknown>;
  } = {}
): Promise<T | null> {
  try {
    return await operation();
  } catch (err) {
    createError(code, err instanceof Error ? err.message : String(err), {
      severity: options.severity ?? "error",
      userMessage: options.userMessage,
      recoverable: options.recoverable ?? true,
      context: {
        ...options.context,
        originalError: err,
      },
    });
    return null;
  }
}

/**
 * Wrap a sync operation with error reporting
 * Returns null if the operation fails
 */
export function withErrorReportingSync<T>(
  code: ErrorCode,
  operation: () => T,
  options: {
    userMessage?: string;
    severity?: ErrorSeverity;
    recoverable?: boolean;
    context?: Record<string, unknown>;
  } = {}
): T | null {
  try {
    return operation();
  } catch (err) {
    createError(code, err instanceof Error ? err.message : String(err), {
      severity: options.severity ?? "error",
      userMessage: options.userMessage,
      recoverable: options.recoverable ?? true,
      context: {
        ...options.context,
        originalError: err,
      },
    });
    return null;
  }
}

// Re-export error codes for convenience
export { ErrorCodes, UserMessages };
export type { AppError, ErrorSeverity, ErrorCode };
