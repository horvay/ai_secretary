/**
 * Sprite Service
 * Handles loading WebM video files for avatar animations.
 *
 * Directory structure is owned by the active companion pack:
 *   <pack>/assets/sprites/standard/<status>/<type>/<folder_name>/animation.webm
 *   <pack>/assets/sprites/one-time/<key>/animation.webm
 */

import { mkdir, readdir, readFile, access, stat } from "fs/promises";
import { join } from "path";
import { getActiveCompanionPack, resolvePackRelativePath } from "./companion-packs";

const DEFAULT_STATUS = "normal";

async function getActiveSpriteRoots() {
  const pack = await getActiveCompanionPack();
  return {
    pack,
    standardRoot: resolvePackRelativePath(pack, pack.manifest.sprites.standardDir),
    oneTimeRoot: resolvePackRelativePath(pack, pack.manifest.sprites.oneTimeDir),
    defaultStatus: pack.manifest.sprites.defaultStatus || DEFAULT_STATUS,
  };
}

export type SpriteType = "idle" | "processing" | "talking";
export type SpriteStatus = string;

/**
 * Metadata for an animated sprite.
 */
export interface AnimatedSpriteMetadata {
  status: SpriteStatus;
  type: SpriteType;
  folder: string;
  sourceFile: string;
}

/**
 * A WebM video sprite
 */
export interface AnimatedSprite {
  mime: "video/webm";
  bytes: Uint8Array;
  metadata: AnimatedSpriteMetadata;
}

/**
 * Sprite info with string-based folder IDs
 */
export interface SpriteInfo {
  source: "pack";
  path: string;
  hasSprites: boolean;
  statuses: SpriteStatus[];
  types: SpriteType[];
  folders: Record<SpriteStatus, Record<SpriteType, string[]>>;
}

/**
 * Ensure directories exist
 */
async function ensureDirectories(): Promise<void> {
  const roots = await getActiveSpriteRoots();
  await mkdir(roots.standardRoot, { recursive: true });
  await mkdir(roots.oneTimeRoot, { recursive: true });
}

/**
 * Check if file or directory exists
 */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const SPRITE_STATE_DIRS: SpriteType[] = ["idle", "processing", "talking"];

/**
 * Get status roots - directories under standard/ that represent different avatar statuses
 */
async function getStatusRoots(): Promise<Record<SpriteStatus, string>> {
  const spriteRoots = await getActiveSpriteRoots();
  const roots: Record<SpriteStatus, string> = {};
  let entries: string[] = [];
  try {
    entries = await readdir(spriteRoots.standardRoot);
  } catch {
    roots[spriteRoots.defaultStatus] = spriteRoots.standardRoot;
    return roots;
  }

  const directories: string[] = [];
  for (const entry of entries) {
    try {
      const entryPath = join(spriteRoots.standardRoot, entry);
      const entryStat = await stat(entryPath);
      if (entryStat.isDirectory()) directories.push(entry);
    } catch {
      // ignore unreadable entries
    }
  }

  const statusCandidates = directories.filter((d) => !SPRITE_STATE_DIRS.includes(d as SpriteType));
  const hasLegacy = SPRITE_STATE_DIRS.some((d) => directories.includes(d));

  if (statusCandidates.length === 0) {
    roots[spriteRoots.defaultStatus] = spriteRoots.standardRoot;
    return roots;
  }

  for (const status of statusCandidates) {
    roots[status] = join(spriteRoots.standardRoot, status);
  }

  if (hasLegacy) {
    roots[spriteRoots.defaultStatus] = spriteRoots.standardRoot;
  }

  return roots;
}

/**
 * Find all WebM files in a type directory.
 */
async function findWebMsForType(
  statusRoot: string,
  type: SpriteType
): Promise<{ folder: string; videoPath: string }[]> {
  const typePath = join(statusRoot, type);
  const results: { folder: string; videoPath: string }[] = [];

  try {
    const folders = await readdir(typePath);

    for (const folder of folders) {
      const folderPath = join(typePath, folder);

      try {
        const folderStat = await stat(folderPath);
        if (!folderStat.isDirectory()) continue;

        const files = await readdir(folderPath);
        const webmFile = files.find((f) => f.toLowerCase().endsWith(".webm"));

        if (webmFile) {
          results.push({
            folder,
            videoPath: join(folderPath, webmFile),
          });
        }
      } catch {
        // Skip unreadable folders
      }
    }
  } catch {
    // Type directory doesn't exist
  }

  return results;
}

/**
 * Get information about available sprites.
 */
export async function getSpriteInfo(): Promise<SpriteInfo> {
  await ensureDirectories();

  const statusRoots = await getStatusRoots();
  const statuses = Object.keys(statusRoots).sort();
  const folders: Record<SpriteStatus, Record<SpriteType, string[]>> = {};
  const typesSet = new Set<SpriteType>();
  let hasSprites = false;

  const ensureFolderMap = (status: SpriteStatus): void => {
    if (!folders[status]) {
      folders[status] = {
        idle: [],
        processing: [],
        talking: [],
      };
    }
  };

  for (const status of statuses) {
    ensureFolderMap(status);
    const statusRoot = statusRoots[status];

    for (const type of SPRITE_STATE_DIRS) {
      const videos = await findWebMsForType(statusRoot, type);

      if (videos.length > 0) {
        folders[status][type] = videos.map((v) => v.folder).sort();
        typesSet.add(type);
        hasSprites = true;
      }
    }
  }

  const spriteRoots = await getActiveSpriteRoots();

  return {
    source: "pack",
    path: spriteRoots.standardRoot,
    hasSprites,
    statuses,
    types: Array.from(typesSet),
    folders,
  };
}

/**
 * Load a WebM video sprite.
 */
export async function loadAnimatedSprite(
  status: SpriteStatus,
  type: SpriteType,
  folder: string
): Promise<AnimatedSprite> {
  const statusRoots = await getStatusRoots();
  const statusRoot = statusRoots[status];

  if (!statusRoot) {
    throw new Error(`Unknown status: ${status}`);
  }

  const folderPath = join(statusRoot, type, folder);

  if (!(await exists(folderPath))) {
    throw new Error(`Folder not found: ${status}/${type}/${folder}`);
  }

  const files = await readdir(folderPath);
  const webmFile = files.find((f) => f.toLowerCase().endsWith(".webm"));

  if (!webmFile) {
    throw new Error(`No .webm file found in ${status}/${type}/${folder}`);
  }

  const videoPath = join(folderPath, webmFile);
  const bytes = new Uint8Array(await readFile(videoPath));

  console.log(`[loadAnimatedSprite] Loaded WebM: ${videoPath} (${bytes.length} bytes)`);

  return {
    mime: "video/webm",
    bytes,
    metadata: {
      status,
      type,
      folder,
      sourceFile: videoPath,
    },
  };
}

/**
 * Load all animated sprites for a type.
 */
export async function loadAnimatedSpritesForType(
  status: SpriteStatus,
  type: SpriteType
): Promise<Record<string, AnimatedSprite>> {
  const info = await getSpriteInfo();
  const folderNames = info.folders[status]?.[type] ?? [];
  const sprites: Record<string, AnimatedSprite> = {};

  for (const folder of folderNames) {
    try {
      sprites[folder] = await loadAnimatedSprite(status, type, folder);
    } catch (error) {
      console.warn(`Failed to load sprite ${status}/${type}/${folder}:`, error);
    }
  }

  return sprites;
}

/**
 * Get user sprites directory path
 */
export async function getUserSpritesDir(): Promise<string> {
  const spriteRoots = await getActiveSpriteRoots();
  return spriteRoots.standardRoot;
}

/**
 * Check if an override animation folder exists
 */
async function overrideFolderExists(key: string): Promise<boolean> {
  const spriteRoots = await getActiveSpriteRoots();
  const overridePath = join(spriteRoots.oneTimeRoot, key);
  return await exists(overridePath);
}

/**
 * Load an override animation sprite sheet
 */
async function loadOverrideSpriteSheet(key: string): Promise<AnimatedSprite> {
  const spriteRoots = await getActiveSpriteRoots();
  const overridePath = join(spriteRoots.oneTimeRoot, key);

  if (!(await exists(overridePath))) {
    throw new Error(`Override folder not found: ${key}`);
  }

  const files = await readdir(overridePath);
  const webmFile = files.find((f) => f.toLowerCase().endsWith(".webm"));

  if (!webmFile) {
    throw new Error(`No .webm file found in one-time/${key}`);
  }

  const videoPath = join(overridePath, webmFile);
  const bytes = new Uint8Array(await readFile(videoPath));

  console.log(`[loadOverrideSpriteSheet] Loaded override WebM: ${videoPath} (${bytes.length} bytes)`);

  return {
    mime: "video/webm",
    bytes,
    metadata: {
      status: "override",
      type: "idle", // override animations don't have a type
      folder: key,
      sourceFile: videoPath,
    },
  };
}

// Export service object
export const spritesService = {
  getSpriteInfo,
  loadAnimatedSprite,
  loadAnimatedSpritesForType,
  getUserSpritesDir,
  overrideFolderExists,
  loadOverrideSpriteSheet,
};
