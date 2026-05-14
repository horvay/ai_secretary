/**
 * Typed app state/settings service.
 *
 * Values are persisted in SQLite as JSON. This module owns generic app_state
 * access so domain services (routines, pi client, etc.) do not become state
 * junk drawers.
 */

import { getDatabase } from "../db";
import { logWarn } from "../utils/logger";

export interface AppStateDefinition<T> {
  defaultValue: T;
  validate: (value: unknown) => value is T;
}

const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isNullableNumber = (value: unknown): value is number | null => value === null || typeof value === "number";
const isPositiveIntegerOrNull = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isInteger(value) && value > 0);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");
const isGBrainIntegrationMode = (value: unknown): value is "mcp" | "cli-call" =>
  value === "mcp" || value === "cli-call";
const isGBrainWriteMode = (value: unknown): value is "off" | "propose" | "auto" =>
  value === "off" || value === "propose" || value === "auto";
const isLocalReasoningMode = (value: unknown): value is "on" | "off" | "auto" =>
  value === "on" || value === "off" || value === "auto";
const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

export const appStateDefinitions = {
  "secretary.status": { defaultValue: "normal", validate: isString },
  "last_voice_activity": { defaultValue: null, validate: isNullableNumber },
  "memory.enabled": { defaultValue: true, validate: isBoolean },
  "memory.conversationLoggingEnabled": { defaultValue: true, validate: isBoolean },
  "memory.screenshotLoggingEnabled": { defaultValue: true, validate: isBoolean },
  "memory.ocrEnabled": { defaultValue: true, validate: isBoolean },
  "memory.retentionDays": { defaultValue: null, validate: isPositiveIntegerOrNull },
  "memory.profileLearningEnabled": { defaultValue: true, validate: isBoolean },
  "memory.lastExportPath": { defaultValue: "", validate: isString },
  "memory.lastClearedSegment": { defaultValue: "", validate: isString },
  "memory.lastForgottenTurnId": { defaultValue: "", validate: isString },
  "companion.activePack": { defaultValue: "ari", validate: isString },
  "avatarOverride.allowAi": { defaultValue: false, validate: isBoolean },
  "pi.sessionId": { defaultValue: "", validate: isString },
  "pi.sessionFile": { defaultValue: "", validate: isString },
  "pi.defaultModel": { defaultValue: "", validate: isString },
  "pi.thinkingLevel": { defaultValue: "", validate: isString },
  "privacy.redactedTerms": { defaultValue: [], validate: isStringArray },
  "voice.microphoneSendToAi": { defaultValue: true, validate: isBoolean },
  "audioTranscripts.speaker.enabled": { defaultValue: false, validate: isBoolean },
  "gbrain.enabled": { defaultValue: false, validate: isBoolean },
  "gbrain.command": { defaultValue: "gbrain", validate: isString },
  "gbrain.home": { defaultValue: null, validate: (value: unknown): value is string | null => value === null || typeof value === "string" },
  "gbrain.integrationMode": { defaultValue: "cli-call", validate: isGBrainIntegrationMode },
  "gbrain.contextLookupEnabled": { defaultValue: true, validate: isBoolean },
  "gbrain.writeMode": { defaultValue: "off", validate: isGBrainWriteMode },
  "gbrain.timeoutMs": { defaultValue: 2500, validate: isPositiveInteger },
  "gbrain.maxContextItems": { defaultValue: 3, validate: isPositiveInteger },
  "localModel.reasoning": { defaultValue: "off", validate: isLocalReasoningMode },
  "localModel.reasoningBudget": { defaultValue: 500, validate: isPositiveInteger },
  "localModel.contextSize": { defaultValue: 65_536, validate: isPositiveInteger },
  "playwright.enabled": { defaultValue: false, validate: isBoolean },
  "firecrawl.enabled": { defaultValue: false, validate: isBoolean },
  "firecrawl.apiKey": { defaultValue: "", validate: isString },
} satisfies Record<string, AppStateDefinition<unknown>>;

export type AppStateKey = keyof typeof appStateDefinitions;
export type AppStateValue<K extends AppStateKey> = (typeof appStateDefinitions)[K]["defaultValue"];

function ensureAppStateShape() {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      value_type TEXT NOT NULL DEFAULT 'json',
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  const columns = db.query("PRAGMA table_info(app_state)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "value_type")) {
    db.exec("ALTER TABLE app_state ADD COLUMN value_type TEXT NOT NULL DEFAULT 'json'");
  }
}

export function getAppStateRaw(key: string): string | null {
  ensureAppStateShape();
  const db = getDatabase();
  const result = db.query("SELECT value FROM app_state WHERE key = ?").get(key) as { value: string } | null;
  return result?.value ?? null;
}

export function setAppStateRaw(key: string, value: string): void {
  ensureAppStateShape();
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);

  db.query(
    `INSERT INTO app_state (key, value, value_type, updated_at)
     VALUES (?, ?, 'string', ?)
     ON CONFLICT(key) DO UPDATE SET value = ?, value_type = 'string', updated_at = ?`
  ).run(key, value, now, value, now);
}

function coerceLegacyRaw<K extends AppStateKey>(key: K, raw: string): AppStateValue<K> | null {
  const definition = appStateDefinitions[key];

  if (definition.validate(raw)) {
    return raw as AppStateValue<K>;
  }

  const lower = raw.trim().toLowerCase();
  if ((lower === "true" || lower === "false" || lower === "1" || lower === "0") && definition.validate(lower === "true" || lower === "1")) {
    return (lower === "true" || lower === "1") as AppStateValue<K>;
  }

  if (raw.trim().length > 0) {
    const asNumber = Number(raw);
    if (!Number.isNaN(asNumber) && definition.validate(asNumber)) {
      return asNumber as AppStateValue<K>;
    }
  }

  return null;
}

export function getSetting<K extends AppStateKey>(key: K): AppStateValue<K> {
  const definition = appStateDefinitions[key];
  const raw = getAppStateRaw(key);
  if (raw === null) return definition.defaultValue as AppStateValue<K>;

  try {
    const parsed = JSON.parse(raw);
    if (definition.validate(parsed)) return parsed as AppStateValue<K>;
  } catch {
    // Backward compatibility: older rows were plain strings.
  }

  const coerced = coerceLegacyRaw(key, raw);
  if (coerced !== null) return coerced;

  logWarn(`[AppState] Invalid persisted value for ${key}; using default`);
  return definition.defaultValue as AppStateValue<K>;
}

export function setSetting<K extends AppStateKey>(key: K, value: AppStateValue<K>): void {
  const definition = appStateDefinitions[key];
  if (!definition.validate(value)) {
    throw new Error(`Invalid app state value for ${key}`);
  }

  ensureAppStateShape();
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);
  const serialized = JSON.stringify(value);

  db.query(
    `INSERT INTO app_state (key, value, value_type, updated_at)
     VALUES (?, ?, 'json', ?)
     ON CONFLICT(key) DO UPDATE SET value = ?, value_type = 'json', updated_at = ?`
  ).run(key, serialized, now, serialized, now);
}

export function initializeAppStateDefaults(): void {
  for (const key of Object.keys(appStateDefinitions) as AppStateKey[]) {
    if (getAppStateRaw(key) !== null) continue;
    setSetting(key, appStateDefinitions[key].defaultValue as never);
  }
}

// Backward-compatible string helpers for existing call sites.
export function getAppState(key: string): string | null {
  const raw = getAppStateRaw(key);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") {
      return String(parsed);
    }
  } catch {
    // fall back to raw storage format
  }
  return raw;
}

export function setAppState(key: string, value: string): void {
  setAppStateRaw(key, value);
}
