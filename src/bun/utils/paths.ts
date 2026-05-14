/**
 * Path utilities for AI Secretary.
 *
 * Ownership model:
 * - resources: shipped/read-only app resources (built-in packs, OCR data, base prompts, tool scripts)
 * - data: mutable private user/app data (memory DB, screenshots, pi sessions, logs, cache, user packs)
 *
 * There is intentionally no fallback to the old runtime/ layout.
 */

import path from "path";
import { homedir } from "os";

export function getProjectRootDir(): string {
  return path.resolve(process.env.AI_SECRETARY_PROJECT_ROOT ?? process.cwd());
}

export function getAiSecretaryDataDir(): string {
  const override = process.env.AI_SECRETARY_DATA_DIR;
  if (override && override.trim().length > 0) {
    return path.resolve(override);
  }

  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local && local.trim().length > 0) {
      return path.join(local, ".ai-secretary");
    }
  }

  return path.join(homedir(), ".ai-secretary");
}

export function getResourcesDir(): string {
  const override = process.env.AI_SECRETARY_RESOURCES_DIR;
  if (override && override.trim().length > 0) {
    return path.resolve(override);
  }

  return path.join(getProjectRootDir(), "resources");
}

export function getAppResourcesDir(): string {
  return path.join(getResourcesDir(), "app");
}

export function getOcrResourcesDir(): string {
  return path.join(getResourcesDir(), "ocr");
}

export function getBuiltinCompanionPacksDir(): string {
  return path.join(getResourcesDir(), "companion-packs");
}

export function getResourcesToolsDir(): string {
  return path.join(getResourcesDir(), "tools");
}

export function getPiWorkspaceDir(): string {
  return path.join(getAiSecretaryDataDir(), "pi", "workspace");
}

export function getUserMemoryDir(): string {
  return path.join(getAiSecretaryDataDir(), "memory");
}

export function getUserPacksDir(): string {
  return path.join(getAiSecretaryDataDir(), "packs");
}

export function getPiDataDir(): string {
  return path.join(getAiSecretaryDataDir(), "pi");
}

export function getAiSecretaryCacheDir(): string {
  return path.join(getAiSecretaryDataDir(), "cache");
}

export function getAiSecretaryLogsDir(): string {
  return path.join(getAiSecretaryDataDir(), "logs");
}

export function getProjectPiDir(): string {
  return path.resolve(process.env.AI_SECRETARY_PI_LOCAL_DIR ?? path.join(getProjectRootDir(), ".pi"));
}

export function getProjectPiAgentDir(): string {
  return path.resolve(process.env.AI_SECRETARY_PI_AGENT_DIR ?? path.join(getProjectPiDir(), "agent"));
}

