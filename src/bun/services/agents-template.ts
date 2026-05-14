/**
 * AGENTS.md Template Service
 * Handles dynamic injection of user profile into the AGENTS.md file
 */

import { readFile, writeFile } from "fs/promises";
import { access } from "fs/promises";
import { constants } from "fs";
import { join } from "path";
import { getProfileSummary } from "./profile";
import { getAppResourcesDir } from "../utils/paths";
import { logInfo, logError, logDebug, logWarn } from "../utils/logger";

// Template placeholder
const PROFILE_PLACEHOLDER = "{{USER_PROFILE}}";

/**
 * Find the app-owned AGENTS.md file in the new resources layout only.
 */
async function findAgentsMdPath(): Promise<string | null> {
  const agentsPath = join(getAppResourcesDir(), "AGENTS.md");
  try {
    await access(agentsPath, constants.R_OK | constants.W_OK);
    logDebug("[AgentsTemplate] Found AGENTS.md at:", agentsPath);
    return agentsPath;
  } catch {
    logWarn("[AgentsTemplate] AGENTS.md not found at expected resources path:", agentsPath);
    return null;
  }
}

// Cache the paths once found
let AGENTS_MD_PATH: string | null = null;
let AGENTS_MD_BACKUP_PATH: string | null = null;

/**
 * Initialize paths (lazy loading)
 */
async function initPaths(): Promise<boolean> {
  if (AGENTS_MD_PATH === null) {
    AGENTS_MD_PATH = await findAgentsMdPath();
    if (AGENTS_MD_PATH) {
      AGENTS_MD_BACKUP_PATH = AGENTS_MD_PATH.replace(".md", ".md.template");
    }
  }
  return AGENTS_MD_PATH !== null;
}

/**
 * Check if AGENTS.md contains the profile placeholder
 */
export async function hasProfilePlaceholder(): Promise<boolean> {
  try {
    if (!(await initPaths()) || !AGENTS_MD_PATH) {
      return false;
    }
    const content = await readFile(AGENTS_MD_PATH, "utf-8");
    return content.includes(PROFILE_PLACEHOLDER);
  } catch {
    return false;
  }
}

/**
 * Update the AGENTS.md file with the current user profile
 * This replaces the {{USER_PROFILE}} placeholder with actual profile data
 */
export async function updateAgentsMdWithProfile(): Promise<void> {
  if (!(await initPaths()) || !AGENTS_MD_PATH || !AGENTS_MD_BACKUP_PATH) {
    logWarn("[AgentsTemplate] Skipping profile injection - AGENTS.md not found");
    return;
  }

  try {
    // Read the template or current file
    let template: string;

    try {
      // Try to read the backup template first
      template = await readFile(AGENTS_MD_BACKUP_PATH, "utf-8");
    } catch {
      // No backup exists, read the current file as template
      template = await readFile(AGENTS_MD_PATH, "utf-8");

      // If the current file has the placeholder, save it as a backup template
      if (template.includes(PROFILE_PLACEHOLDER)) {
        await writeFile(AGENTS_MD_BACKUP_PATH, template, "utf-8");
        logDebug("[AgentsTemplate] Saved AGENTS.md as template backup");
      }
    }

    // Check if template has the placeholder
    if (!template.includes(PROFILE_PLACEHOLDER)) {
      logDebug("[AgentsTemplate] No placeholder found in AGENTS.md, skipping profile injection");
      return;
    }

    // Get the current profile summary
    const profileSummary = await getProfileSummary();

    // Replace placeholder with profile content
    const updatedContent = template.replace(PROFILE_PLACEHOLDER, profileSummary);

    // Write the updated content
    await writeFile(AGENTS_MD_PATH, updatedContent, "utf-8");

    logInfo("[AgentsTemplate] Updated AGENTS.md with user profile");
    logDebug("[AgentsTemplate] Profile content:", profileSummary);
  } catch (error) {
    logError("[AgentsTemplate] Failed to update AGENTS.md:", error);
    // Non-fatal - just log the error
  }
}

/**
 * Reset AGENTS.md back to the template (with placeholder)
 * Useful for debugging or when profile needs to be cleared
 */
export async function resetAgentsMdToTemplate(): Promise<void> {
  if (!(await initPaths()) || !AGENTS_MD_PATH || !AGENTS_MD_BACKUP_PATH) {
    logWarn("[AgentsTemplate] Cannot reset - AGENTS.md not found");
    return;
  }

  try {
    const template = await readFile(AGENTS_MD_BACKUP_PATH, "utf-8");
    await writeFile(AGENTS_MD_PATH, template, "utf-8");
    logInfo("[AgentsTemplate] Reset AGENTS.md to template");
  } catch (error) {
    logError("[AgentsTemplate] Failed to reset AGENTS.md:", error);
  }
}

/**
 * Initialize the template system
 * Should be called on app startup after memory is initialized
 * Non-fatal - profile injection is a nice-to-have feature
 */
export async function initAgentsTemplate(): Promise<void> {
  try {
    await updateAgentsMdWithProfile();
  } catch (error) {
    // Non-fatal - log but don't throw
    logError("[AgentsTemplate] Failed to initialize agents template:", error);
  }
}

