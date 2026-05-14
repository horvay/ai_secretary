import { copyFile, mkdir, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

const EXCLUDED_DIR_NAMES = new Set([".git"]);

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory() && EXCLUDED_DIR_NAMES.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else if (entry.isFile()) {
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(from, to);
    }
  }
}

async function findResourceTargets(buildRoot: string): Promise<string[]> {
  const targets = new Set<string>();
  if (!(await exists(buildRoot))) return [];

  async function scan(dir: string, depth: number): Promise<void> {
    if (depth > 6) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      const resources = path.join(full, "Resources", "app", "resources");
      if (existsSync(path.dirname(resources))) targets.add(resources);
      await scan(full, depth + 1);
    }
  }

  await scan(buildRoot, 0);
  return Array.from(targets);
}

async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const sourceResources = path.join(projectRoot, "resources");
  const buildRoot = path.join(projectRoot, "build");

  if (!(await exists(sourceResources))) {
    console.warn(`[postBuild] Source resources folder not found: ${sourceResources}`);
    return;
  }

  const targets = await findResourceTargets(buildRoot);
  if (targets.length === 0) {
    console.warn(`[postBuild] No build resource targets found under: ${buildRoot}`);
    return;
  }

  for (const target of targets) {
    console.log(`[postBuild] Syncing resources into: ${target}`);
    await copyDir(sourceResources, target);
  }
}

main().catch((err) => {
  console.error("[postBuild] Failed to copy resources folder:", err);
  process.exit(1);
});
