/**
 * Profile Service for Ari
 * Manages the user_profile.md file - reads, writes, and reconciles user facts
 */

import { readFile, writeFile, access } from "fs/promises";
import { constants } from "fs";
import { getUserProfilePath } from "../db";
import { logInfo, logError, logDebug } from "../utils/logger";

/**
 * User profile sections
 */
export interface UserProfile {
  personalInfo: {
    name?: string;
    preferredName?: string;
    location?: string;
  };
  preferences: {
    communicationStyle?: string;
    [key: string]: string | undefined;
  };
  schedulePatterns: {
    timezone?: string;
    [key: string]: string | undefined;
  };
  interests: string[];
  relationships: {
    [key: string]: string;
  };
  notes: string[];
}

/**
 * Default empty profile
 */
const DEFAULT_PROFILE: UserProfile = {
  personalInfo: {},
  preferences: {},
  schedulePatterns: {},
  interests: [],
  relationships: {},
  notes: [],
};

/**
 * Default profile markdown template
 */
const DEFAULT_PROFILE_MD = `# User Profile

This file contains information about you that Ari has learned from your conversations.
Feel free to edit this file directly - Ari will respect your changes!

## Personal Info
- Name:
- Preferred name:
- Location:

## Preferences
- Communication style:

## Schedule Patterns
- Timezone:

## Interests

## Important Relationships

## Notes
`;

/**
 * Check if profile file exists
 */
export async function profileExists(): Promise<boolean> {
  try {
    await access(getUserProfilePath(), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialize the profile file if it doesn't exist
 */
export async function initProfile(): Promise<void> {
  const exists = await profileExists();
  if (!exists) {
    await writeFile(getUserProfilePath(), DEFAULT_PROFILE_MD, "utf-8");
    logInfo("[Profile] Created default user_profile.md");
  }
}

/**
 * Read the raw profile markdown
 */
export async function readProfileRaw(): Promise<string> {
  try {
    await initProfile();
    return await readFile(getUserProfilePath(), "utf-8");
  } catch (error) {
    logError("[Profile] Failed to read profile:", error);
    return DEFAULT_PROFILE_MD;
  }
}

/**
 * Write the raw profile markdown
 */
export async function writeProfileRaw(content: string): Promise<void> {
  try {
    await writeFile(getUserProfilePath(), content, "utf-8");
    logDebug("[Profile] Profile saved");
  } catch (error) {
    logError("[Profile] Failed to write profile:", error);
    throw error;
  }
}

/**
 * Parse profile markdown into structured data
 */
export function parseProfile(markdown: string): UserProfile {
  const profile: UserProfile = {
    personalInfo: {},
    preferences: {},
    schedulePatterns: {},
    interests: [],
    relationships: {},
    notes: [],
  };

  // Split into sections
  const sections = markdown.split(/^## /m).slice(1); // Skip everything before first ##

  for (const section of sections) {
    const lines = section.split("\n");
    const sectionTitle = lines[0].trim().toLowerCase();
    const content = lines.slice(1);

    switch (sectionTitle) {
      case "personal info":
        for (const line of content) {
          const match = line.match(/^- ([^:]+):\s*(.*)$/);
          if (match) {
            const key = match[1].trim().toLowerCase().replace(/\s+/g, "");
            const value = match[2].trim();
            if (value) {
              if (key === "name") profile.personalInfo.name = value;
              else if (key === "preferredname") profile.personalInfo.preferredName = value;
              else if (key === "location") profile.personalInfo.location = value;
            }
          }
        }
        break;

      case "preferences":
        for (const line of content) {
          const match = line.match(/^- ([^:]+):\s*(.*)$/);
          if (match) {
            const key = match[1].trim().toLowerCase().replace(/\s+/g, "_");
            const value = match[2].trim();
            if (value) {
              if (key === "communication_style") profile.preferences.communicationStyle = value;
              else profile.preferences[key] = value;
            }
          }
        }
        break;

      case "schedule patterns":
        for (const line of content) {
          const match = line.match(/^- ([^:]+):\s*(.*)$/);
          if (match) {
            const key = match[1].trim().toLowerCase().replace(/\s+/g, "_");
            const value = match[2].trim();
            if (value) {
              if (key === "timezone") profile.schedulePatterns.timezone = value;
              else profile.schedulePatterns[key] = value;
            }
          }
        }
        break;

      case "interests":
        for (const line of content) {
          const match = line.match(/^- (.+)$/);
          if (match) {
            const value = match[1].trim();
            if (value) {
              profile.interests.push(value);
            }
          }
        }
        break;

      case "important relationships":
        for (const line of content) {
          const match = line.match(/^- ([^:]+):\s*(.*)$/);
          if (match) {
            const key = match[1].trim();
            const value = match[2].trim();
            if (value) {
              profile.relationships[key] = value;
            }
          }
        }
        break;

      case "notes":
        for (const line of content) {
          const match = line.match(/^- (.+)$/);
          if (match) {
            const value = match[1].trim();
            if (value) {
              profile.notes.push(value);
            }
          }
        }
        break;
    }
  }

  return profile;
}

/**
 * Serialize profile to markdown
 */
export function serializeProfile(profile: UserProfile): string {
  let md = `# User Profile

This file contains information about you that Ari has learned from your conversations.
Feel free to edit this file directly - Ari will respect your changes!

## Personal Info
- Name: ${profile.personalInfo.name ?? ""}
- Preferred name: ${profile.personalInfo.preferredName ?? ""}
- Location: ${profile.personalInfo.location ?? ""}

## Preferences
- Communication style: ${profile.preferences.communicationStyle ?? ""}`;

  // Add any additional preferences
  for (const [key, value] of Object.entries(profile.preferences)) {
    if (key !== "communicationStyle" && value) {
      md += `\n- ${key.replace(/_/g, " ")}: ${value}`;
    }
  }

  md += `

## Schedule Patterns
- Timezone: ${profile.schedulePatterns.timezone ?? ""}`;

  // Add any additional schedule patterns
  for (const [key, value] of Object.entries(profile.schedulePatterns)) {
    if (key !== "timezone" && value) {
      md += `\n- ${key.replace(/_/g, " ")}: ${value}`;
    }
  }

  md += `

## Interests`;
  if (profile.interests.length > 0) {
    for (const interest of profile.interests) {
      md += `\n- ${interest}`;
    }
  }

  md += `

## Important Relationships`;
  for (const [key, value] of Object.entries(profile.relationships)) {
    if (value) {
      md += `\n- ${key}: ${value}`;
    }
  }

  md += `

## Notes`;
  if (profile.notes.length > 0) {
    for (const note of profile.notes) {
      md += `\n- ${note}`;
    }
  }

  return md + "\n";
}

/**
 * Read and parse the profile
 */
export async function loadProfile(): Promise<UserProfile> {
  const markdown = await readProfileRaw();
  return parseProfile(markdown);
}

/**
 * Save a profile (serialize and write)
 */
export async function saveProfile(profile: UserProfile): Promise<void> {
  const markdown = serializeProfile(profile);
  await writeProfileRaw(markdown);
}

/**
 * Update specific fields in the profile
 * Preserves existing user edits where possible
 */
export async function updateProfile(updates: Partial<UserProfile>): Promise<UserProfile> {
  const current = await loadProfile();

  // Merge personal info
  if (updates.personalInfo) {
    current.personalInfo = {
      ...current.personalInfo,
      ...updates.personalInfo,
    };
  }

  // Merge preferences
  if (updates.preferences) {
    current.preferences = {
      ...current.preferences,
      ...updates.preferences,
    };
  }

  // Merge schedule patterns
  if (updates.schedulePatterns) {
    current.schedulePatterns = {
      ...current.schedulePatterns,
      ...updates.schedulePatterns,
    };
  }

  // Add new interests (avoid duplicates)
  if (updates.interests) {
    const existingLower = current.interests.map((i) => i.toLowerCase());
    for (const interest of updates.interests) {
      if (!existingLower.includes(interest.toLowerCase())) {
        current.interests.push(interest);
      }
    }
  }

  // Merge relationships
  if (updates.relationships) {
    current.relationships = {
      ...current.relationships,
      ...updates.relationships,
    };
  }

  // Add new notes (avoid exact duplicates)
  if (updates.notes) {
    for (const note of updates.notes) {
      if (!current.notes.includes(note)) {
        current.notes.push(note);
      }
    }
  }

  await saveProfile(current);
  logDebug("[Profile] Profile updated");
  return current;
}

/**
 * Get profile summary for injection into system prompt
 * Returns a concise summary suitable for AI context
 */
export async function getProfileSummary(): Promise<string> {
  const profile = await loadProfile();
  const parts: string[] = [];

  // Personal info
  if (profile.personalInfo.name) {
    const name = profile.personalInfo.preferredName || profile.personalInfo.name;
    parts.push(`User's name: ${name}`);
  }
  if (profile.personalInfo.location) {
    parts.push(`Location: ${profile.personalInfo.location}`);
  }

  // Preferences
  if (profile.preferences.communicationStyle) {
    parts.push(`Communication style: ${profile.preferences.communicationStyle}`);
  }
  for (const [key, value] of Object.entries(profile.preferences)) {
    if (key !== "communicationStyle" && value) {
      parts.push(`${key.replace(/_/g, " ")}: ${value}`);
    }
  }

  // Schedule
  if (profile.schedulePatterns.timezone) {
    parts.push(`Timezone: ${profile.schedulePatterns.timezone}`);
  }

  // Interests
  if (profile.interests.length > 0) {
    parts.push(`Interests: ${profile.interests.join(", ")}`);
  }

  // Relationships
  const relationships = Object.entries(profile.relationships).filter(([_, v]) => v);
  if (relationships.length > 0) {
    parts.push(`Relationships: ${relationships.map(([k, v]) => `${k}: ${v}`).join(", ")}`);
  }

  // Notes
  if (profile.notes.length > 0) {
    parts.push(`Notes: ${profile.notes.join("; ")}`);
  }

  if (parts.length === 0) {
    return "No user profile information available yet.";
  }

  return `User Profile:\n${parts.map((p) => `- ${p}`).join("\n")}`;
}

/**
 * Check if profile has any meaningful content
 */
export async function hasProfileContent(): Promise<boolean> {
  const profile = await loadProfile();
  return (
    !!profile.personalInfo.name ||
    !!profile.personalInfo.location ||
    profile.interests.length > 0 ||
    Object.keys(profile.relationships).length > 0 ||
    profile.notes.length > 0
  );
}

