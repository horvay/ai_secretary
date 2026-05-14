import { existsSync } from "fs";
import { mkdir, readdir, readFile } from "fs/promises";
import path from "path";
import { getBuiltinCompanionPacksDir, getProjectRootDir, getUserPacksDir } from "../utils/paths";
import { logDebug, logWarn } from "../utils/logger";
import { getAppState, setAppState } from "./app-state";

const ACTIVE_PACK_KEY = "companion.activePack";
const DEFAULT_PACK_ID = "ari";
let volatileActivePackID: string | null = null;
const LEGACY_SPRITE_TYPE_DIRS = ["idle", "processing", "talking"] as const;
const KNOWN_CAPABILITY_IDS = ["memory", "reminders", "lists", "tasks", "routines", "screenshots", "playwright", "websearch"] as const;
const DEFAULT_CAPABILITIES: CompanionPackCapabilities = {
  memory: true,
  reminders: true,
  lists: true,
  tasks: true,
  routines: true,
  screenshots: true,
  playwright: true,
  websearch: false,
};
const PACK_ID_RE = /^[a-z0-9._-]{1,80}$/;

export type CompanionPackSource = "env" | "user" | "project" | "builtin";
export type CompanionPackCapability = (typeof KNOWN_CAPABILITY_IDS)[number];
export type CompanionPackCapabilities = Record<CompanionPackCapability, boolean>;

export interface CompanionPackModelConfig {
  providerID: string;
  modelID: string;
}

export interface CompanionPackManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  persona: string;
  sprites: {
    standardDir: string;
    oneTimeDir: string;
    defaultStatus: string;
  };
  markers: {
    states: string[];
    animations: string[];
  };
  capabilities: CompanionPackCapabilities;
  model?: CompanionPackModelConfig;
  skillsDir?: string;
  extensionsDir?: string;
}

export interface CompanionPack {
  manifest: CompanionPackManifest;
  packDir: string;
  manifestPath: string;
  source: CompanionPackSource;
}

export interface CompanionPackSummary {
  id: string;
  name: string;
  version: string;
  description?: string;
  source: CompanionPackSource;
}

export interface CompanionPackValidationIssue {
  level: "error" | "warning";
  code: string;
  message: string;
}

function getEnvPackRoots() {
  const raw = process.env.AI_SECRETARY_PACK_DIRS?.trim();
  if (!raw) return [];
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((root) => ({ root: path.resolve(root), source: "env" as const }));
}

function getPackRoots() {
  const projectRoot = getProjectRootDir();
  return [
    ...getEnvPackRoots(),
    { root: getUserPacksDir(), source: "user" as const },
    { root: path.join(projectRoot, "packs"), source: "project" as const },
    { root: getBuiltinCompanionPacksDir(), source: "builtin" as const },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readRequiredString(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  if (!isNonEmptyString(value)) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function readOptionalString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string when provided`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringList(value: unknown, label: string) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings`);
  }

  const normalized = value
    .map((entry) => {
      if (typeof entry !== "string") {
        throw new Error(`${label} must only contain strings`);
      }
      return entry.trim();
    })
    .filter((entry) => entry.length > 0);

  return Array.from(new Set(normalized));
}

function normalizeCapabilities(value: unknown) {
  const capabilities: CompanionPackCapabilities = { ...DEFAULT_CAPABILITIES };
  if (value == null) return capabilities;
  if (!isRecord(value)) {
    throw new Error("capabilities must be an object when provided");
  }

  for (const capability of KNOWN_CAPABILITY_IDS) {
    const raw = value[capability];
    if (typeof raw === "boolean") {
      capabilities[capability] = raw;
    }
  }

  return capabilities;
}

function normalizeManifest(raw: unknown, manifestPath: string) {
  if (!isRecord(raw)) {
    throw new Error(`Pack manifest must be a JSON object: ${manifestPath}`);
  }

  const spritesRaw = raw.sprites;
  if (!isRecord(spritesRaw)) {
    throw new Error("sprites must be an object");
  }

  const markersRaw = raw.markers;
  if (!isRecord(markersRaw)) {
    throw new Error("markers must be an object");
  }

  const modelRaw = raw.model;
  if (modelRaw != null && !isRecord(modelRaw)) {
    throw new Error("model must be an object when provided");
  }

  const manifest: CompanionPackManifest = {
    id: readRequiredString(raw, "id", "id"),
    name: readRequiredString(raw, "name", "name"),
    version: readRequiredString(raw, "version", "version"),
    description: readOptionalString(raw, "description"),
    persona: readRequiredString(raw, "persona", "persona"),
    sprites: {
      standardDir: readRequiredString(spritesRaw, "standardDir", "sprites.standardDir"),
      oneTimeDir: readRequiredString(spritesRaw, "oneTimeDir", "sprites.oneTimeDir"),
      defaultStatus: readRequiredString(spritesRaw, "defaultStatus", "sprites.defaultStatus"),
    },
    markers: {
      states: normalizeStringList(markersRaw.states, "markers.states"),
      animations: normalizeStringList(markersRaw.animations, "markers.animations"),
    },
    capabilities: normalizeCapabilities(raw.capabilities),
    model: modelRaw
      ? {
          providerID: readRequiredString(modelRaw, "providerID", "model.providerID"),
          modelID: readRequiredString(modelRaw, "modelID", "model.modelID"),
        }
      : undefined,
    skillsDir: readOptionalString(raw, "skillsDir"),
    extensionsDir: readOptionalString(raw, "extensionsDir"),
  };

  if (!PACK_ID_RE.test(manifest.id)) {
    throw new Error(`id must match ${PACK_ID_RE}`);
  }

  return manifest;
}

function resolvePackPath(packDir: string, relativePath: string) {
  return path.resolve(packDir, relativePath);
}

function formatIssues(issues: CompanionPackValidationIssue[]) {
  return issues.map((issue) => `${issue.level.toUpperCase()} ${issue.code}: ${issue.message}`).join("; ");
}

function getStatusDirExists(standardRoot: string, status: string, defaultStatus: string) {
  const explicitStatusDir = path.join(standardRoot, status);
  if (existsSync(explicitStatusDir)) return true;

  if (status !== defaultStatus) return false;
  return LEGACY_SPRITE_TYPE_DIRS.some((typeDir) => existsSync(path.join(standardRoot, typeDir)));
}

async function loadPackFromDir(packDir: string, source: CompanionPackSource): Promise<CompanionPack | null> {
  const manifestPath = path.join(packDir, "pack.json");
  if (!existsSync(manifestPath)) return null;

  const raw = await readFile(manifestPath, "utf8");
  const manifest = normalizeManifest(JSON.parse(raw), manifestPath);
  const pack: CompanionPack = { manifest, packDir, manifestPath, source };
  const issues = await validateCompanionPack(pack);
  const errors = issues.filter((issue) => issue.level === "error");
  const warnings = issues.filter((issue) => issue.level === "warning");

  if (warnings.length > 0) {
    logWarn(`[CompanionPack] ${manifest.id}: ${formatIssues(warnings)}`);
  }
  if (errors.length > 0) {
    throw new Error(formatIssues(errors));
  }

  return pack;
}

async function loadAllCompanionPacks() {
  const packs = new Map<string, CompanionPack>();

  for (const { root, source } of getPackRoots()) {
    if (!existsSync(root)) continue;
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const packDir = path.join(root, entry.name);
      try {
        const pack = await loadPackFromDir(packDir, source);
        if (!pack) continue;
        // Roots are searched from highest to lowest priority; keep the first match.
        if (!packs.has(pack.manifest.id)) {
          packs.set(pack.manifest.id, pack);
        }
      } catch (error) {
        logWarn(`[CompanionPack] Skipping invalid pack at ${packDir}:`, error);
      }
    }
  }

  return packs;
}

export async function validateCompanionPack(pack: CompanionPack): Promise<CompanionPackValidationIssue[]> {
  const issues: CompanionPackValidationIssue[] = [];
  const personaPath = resolvePackRelativePath(pack, pack.manifest.persona);
  const standardRoot = resolvePackRelativePath(pack, pack.manifest.sprites.standardDir);
  const oneTimeRoot = resolvePackRelativePath(pack, pack.manifest.sprites.oneTimeDir);

  if (pack.manifest.markers.states.length === 0) {
    issues.push({ level: "error", code: "states.empty", message: "markers.states must contain at least one status" });
  }

  if (pack.manifest.markers.animations.length === 0) {
    issues.push({
      level: "warning",
      code: "animations.empty",
      message: "markers.animations is empty, so the companion will have no declared one-shot animation vocabulary",
    });
  }

  if (!pack.manifest.markers.states.includes(pack.manifest.sprites.defaultStatus)) {
    issues.push({
      level: "error",
      code: "defaultStatus.unknown",
      message: `sprites.defaultStatus \"${pack.manifest.sprites.defaultStatus}\" is not declared in markers.states`,
    });
  }

  if (!existsSync(personaPath)) {
    issues.push({
      level: "error",
      code: "persona.missing",
      message: `persona file not found: ${personaPath}`,
    });
  }

  if (!existsSync(standardRoot)) {
    issues.push({
      level: "error",
      code: "sprites.standardDir.missing",
      message: `sprites.standardDir not found: ${standardRoot}`,
    });
  }

  if (!existsSync(oneTimeRoot)) {
    issues.push({
      level: "error",
      code: "sprites.oneTimeDir.missing",
      message: `sprites.oneTimeDir not found: ${oneTimeRoot}`,
    });
  }

  if (existsSync(standardRoot)) {
    for (const status of pack.manifest.markers.states) {
      if (!getStatusDirExists(standardRoot, status, pack.manifest.sprites.defaultStatus)) {
        issues.push({
          level: "error",
          code: "state.missingSprites",
          message: `No sprite status directory found for [state:${status}] under ${standardRoot}`,
        });
      }
    }
  }

  if (existsSync(oneTimeRoot)) {
    for (const animation of pack.manifest.markers.animations) {
      const animationDir = path.join(oneTimeRoot, animation);
      if (!existsSync(animationDir)) {
        issues.push({
          level: "error",
          code: "animation.missingSprites",
          message: `No one-shot animation directory found for [anim:${animation}] under ${oneTimeRoot}`,
        });
      }
    }
  }

  if (pack.manifest.skillsDir) {
    const skillsDir = resolvePackRelativePath(pack, pack.manifest.skillsDir);
    if (!existsSync(skillsDir)) {
      issues.push({
        level: "warning",
        code: "skillsDir.missing",
        message: `skillsDir does not exist yet: ${skillsDir}`,
      });
    }
  }

  if (pack.manifest.extensionsDir) {
    const extensionsDir = resolvePackRelativePath(pack, pack.manifest.extensionsDir);
    if (!existsSync(extensionsDir)) {
      issues.push({
        level: "warning",
        code: "extensionsDir.missing",
        message: `extensionsDir does not exist yet: ${extensionsDir}`,
      });
    }
  }

  return issues;
}

export async function listCompanionPacks(): Promise<CompanionPackSummary[]> {
  const packs = await loadAllCompanionPacks();
  return Array.from(packs.values())
    .map((pack) => ({
      id: pack.manifest.id,
      name: pack.manifest.name,
      version: pack.manifest.version,
      description: pack.manifest.description,
      source: pack.source,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCompanionPack(packID: string): Promise<CompanionPack | null> {
  const packs = await loadAllCompanionPacks();
  return packs.get(packID) ?? null;
}

export function getActiveCompanionPackID() {
  const env = process.env.AI_SECRETARY_ACTIVE_PACK?.trim();
  if (env) return env;
  if (volatileActivePackID) return volatileActivePackID;

  try {
    const saved = String(getAppState(ACTIVE_PACK_KEY) ?? "").trim();
    return saved || DEFAULT_PACK_ID;
  } catch {
    return DEFAULT_PACK_ID;
  }
}

export async function getActiveCompanionPack(): Promise<CompanionPack> {
  const requested = getActiveCompanionPackID();
  const pack = await getCompanionPack(requested);
  if (pack) return pack;

  if (requested !== DEFAULT_PACK_ID) {
    logWarn(`[CompanionPack] Active pack ${requested} was not found. Falling back to ${DEFAULT_PACK_ID}.`);
  }

  const fallback = await getCompanionPack(DEFAULT_PACK_ID);
  if (!fallback) {
    throw new Error(`Default companion pack not found: ${DEFAULT_PACK_ID}`);
  }
  return fallback;
}

export async function setActiveCompanionPackID(packID: string) {
  const pack = await getCompanionPack(packID);
  if (!pack) throw new Error(`Unknown companion pack: ${packID}`);
  volatileActivePackID = packID;
  try {
    setAppState(ACTIVE_PACK_KEY, packID);
  } catch (error) {
    logDebug(`[CompanionPack] Failed to persist active pack ${packID}; keeping volatile selection only`, error);
  }
  return pack;
}

export async function readActiveCompanionPersona() {
  const pack = await getActiveCompanionPack();
  const personaPath = resolvePackPath(pack.packDir, pack.manifest.persona);
  return readFile(personaPath, "utf8");
}

export async function ensureProjectPackDirs() {
  const projectRoot = getProjectRootDir();
  await mkdir(path.join(projectRoot, "packs"), { recursive: true });
}

export function resolvePackRelativePath(pack: CompanionPack, relativePath: string) {
  return resolvePackPath(pack.packDir, relativePath);
}

export function getCompanionPackMarkerSets(pack: CompanionPack) {
  return {
    states: new Set(pack.manifest.markers.states),
    animations: new Set(pack.manifest.markers.animations),
  };
}

export function isCompanionPackCapabilityEnabled(pack: CompanionPack, capability: CompanionPackCapability) {
  return pack.manifest.capabilities[capability] !== false;
}
