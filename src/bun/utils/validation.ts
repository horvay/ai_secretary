/**
 * Input Validation Utilities
 * Security-focused validation for RPC handlers and file operations
 */

import { join, resolve, relative, isAbsolute, normalize, basename, dirname } from "path";
import { homedir } from "os";

export interface ValidationResult {
  valid: boolean;
  error?: string;
  sanitized?: string;
}

/**
 * String validation with length limits
 */
export function validateString(
  value: unknown,
  options: {
    minLength?: number;
    maxLength?: number;
    required?: boolean;
    name?: string;
  } = {}
): ValidationResult {
  const { minLength = 0, maxLength = 10000, required = true, name = "value" } = options;

  if (value === undefined || value === null) {
    if (required) return { valid: false, error: `${name} is required` };
    return { valid: true, sanitized: "" };
  }

  if (typeof value !== "string") {
    return { valid: false, error: `${name} must be a string` };
  }

  const trimmed = value.trim();

  if (required && trimmed.length === 0) {
    return { valid: false, error: `${name} cannot be empty` };
  }

  if (trimmed.length < minLength) {
    return { valid: false, error: `${name} must be at least ${minLength} characters` };
  }

  if (trimmed.length > maxLength) {
    return { valid: false, error: `${name} cannot exceed ${maxLength} characters` };
  }

  return { valid: true, sanitized: trimmed };
}

/**
 * Validate base64 data
 */
export function validateBase64(value: unknown, name = "data"): ValidationResult {
  if (typeof value !== "string") {
    return { valid: false, error: `${name} must be a string` };
  }

  // Check for data URL format
  const base64Regex = /^data:[\w/+-]+;base64,[A-Za-z0-9+/]+=*$/;
  const rawBase64Regex = /^[A-Za-z0-9+/]+=*$/;

  if (!base64Regex.test(value) && !rawBase64Regex.test(value)) {
    return { valid: false, error: `${name} is not valid base64` };
  }

  return { valid: true, sanitized: value };
}

/**
 * Get allowed directories for file writes
 * These are the only directories where files can be written
 */
export function getAllowedWriteDirs(): string[] {
  return [
    process.cwd(),
    join(homedir(), "AISecretary"),
    join(homedir(), "Pictures"),
    join(homedir(), "Downloads"),
  ];
}

/**
 * Validate file path for security
 * Ensures paths are within allowed directories and have valid extensions
 */
export function validateFilePath(
  filePath: unknown,
  options: {
    allowedDirs?: string[];
    allowedExtensions?: string[];
    name?: string;
  } = {}
): ValidationResult {
  const {
    allowedDirs = getAllowedWriteDirs(),
    allowedExtensions = [".png", ".jpg", ".jpeg"],
    name = "filePath",
  } = options;

  if (typeof filePath !== "string") {
    return { valid: false, error: `${name} must be a string` };
  }

  if (filePath.trim().length === 0) {
    return { valid: false, error: `${name} cannot be empty` };
  }

  // Normalize and resolve the path
  const normalized = normalize(filePath);

  // Check for path traversal attempts
  if (normalized.includes("..")) {
    return { valid: false, error: `${name} cannot contain path traversal (..)` };
  }

  // Check for null bytes (security vulnerability)
  if (filePath.includes("\0")) {
    return { valid: false, error: `${name} contains invalid characters` };
  }

  // Resolve to absolute path
  const absolutePath = isAbsolute(normalized) ? normalized : resolve(process.cwd(), normalized);

  // Check if path is within allowed directories
  const isAllowed = allowedDirs.some((dir) => {
    try {
      const rel = relative(dir, absolutePath);
      return !rel.startsWith("..") && !isAbsolute(rel);
    } catch {
      return false;
    }
  });

  if (!isAllowed) {
    return {
      valid: false,
      error: `${name} must be within allowed directories (${allowedDirs.join(", ")})`,
    };
  }

  // Check extension
  const ext = absolutePath.toLowerCase().slice(absolutePath.lastIndexOf("."));
  if (!allowedExtensions.includes(ext)) {
    return {
      valid: false,
      error: `${name} must have extension: ${allowedExtensions.join(", ")}`,
    };
  }

  // Sanitize filename (remove special chars except basic ones)
  const filename = basename(absolutePath);
  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const dir = dirname(absolutePath);
  const sanitizedPath = join(dir, sanitizedFilename);

  return { valid: true, sanitized: sanitizedPath };
}

/**
 * Validate boolean value
 */
export function validateBoolean(value: unknown, name = "value"): ValidationResult & { value?: boolean } {
  if (value === undefined || value === null) {
    return { valid: true, value: false };
  }

  if (typeof value === "boolean") {
    return { valid: true, value };
  }

  if (value === "true" || value === 1) {
    return { valid: true, value: true };
  }

  if (value === "false" || value === 0) {
    return { valid: true, value: false };
  }

  return { valid: false, error: `${name} must be a boolean` };
}

/**
 * Validate integer value
 */
export function validateInteger(
  value: unknown,
  options: {
    min?: number;
    max?: number;
    required?: boolean;
    name?: string;
  } = {}
): ValidationResult & { value?: number } {
  const { min, max, required = true, name = "value" } = options;

  if (value === undefined || value === null) {
    if (required) return { valid: false, error: `${name} is required` };
    return { valid: true };
  }

  const num = typeof value === "number" ? value : parseInt(String(value), 10);

  if (isNaN(num) || !Number.isInteger(num)) {
    return { valid: false, error: `${name} must be an integer` };
  }

  if (min !== undefined && num < min) {
    return { valid: false, error: `${name} must be at least ${min}` };
  }

  if (max !== undefined && num > max) {
    return { valid: false, error: `${name} cannot exceed ${max}` };
  }

  return { valid: true, value: num };
}

/**
 * Helper to validate params before handler execution
 * Creates a wrapper that validates all parameters
 */
export function withValidation<T extends Record<string, unknown>, R>(
  validators: Partial<Record<keyof T, (value: unknown) => ValidationResult>>,
  handler: (params: T) => Promise<R>
): (params: T) => Promise<R> {
  return async (params: T) => {
    for (const [key, validate] of Object.entries(validators)) {
      if (validate) {
        const result = (validate as (value: unknown) => ValidationResult)(params[key as keyof T]);
        if (!result.valid) {
          throw new Error(`Validation failed for ${key}: ${result.error}`);
        }
      }
    }
    return handler(params);
  };
}
