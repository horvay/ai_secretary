/**
 * Daily Summary Service for Ari
 * Summarizes the day's interactions and updates user profile
 */

import { writeFile } from "fs/promises";
import { join } from "path";
import {
  getTodaysInteractions,
  saveDailySummary,
  getDailySummary,
  getInteractionCount
} from "./memory";
import { updateProfile, loadProfile, type UserProfile } from "./profile";
import { getMemorySettings } from "./memory";
import { getDailyDir } from "../db";
import { getAgentClient } from "./agent-client";
import { logInfo, logError, logDebug } from "../utils/logger";

/**
 * Summary result
 */
export interface DailySummaryResult {
  date: string;
  summary: string;
  interactionCount: number;
  profileUpdates: Partial<UserProfile> | null;
  savedToFile: boolean;
}

/**
 * Get today's date string (YYYY-MM-DD)
 */
function getTodayDateString(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Get today's date as integer (YYYYMMDD)
 */
function getTodayDateInt(): number {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/**
 * Convert date string (YYYY-MM-DD) to integer (YYYYMMDD)
 */
function dateStringToInt(dateStr: string): number {
  return parseInt(dateStr.replace(/-/g, ""), 10);
}

/**
 * Format interactions for LLM summarization
 */
function formatInteractionsForSummary(interactions: { role: string; content: string; timestamp: number }[]): string {
  return interactions
    .map((i) => {
      const time = new Date(i.timestamp).toLocaleTimeString();
      const role = i.role === "user" ? "User" : "Ari";
      return `[${time}] ${role}: ${i.content}`;
    })
    .join("\n\n");
}

/**
 * Generate daily summary using the embedded agent backend
 */
export async function generateDailySummary(date?: string): Promise<DailySummaryResult | null> {
  const targetDate = date ?? getTodayDateString();
  const memorySettings = getMemorySettings();

  logInfo("[DailySummary] Generating summary for", targetDate);

  if (!memorySettings.enabled) {
    logInfo("[DailySummary] Memory disabled, skipping daily summary generation");
    return null;
  }

  // Check if summary already exists
  const existing = getDailySummary(targetDate);
  if (existing) {
    logDebug("[DailySummary] Summary already exists for", targetDate);
    // Could optionally regenerate here
  }

  // Get today's interactions
  const interactions = getTodaysInteractions();

  if (interactions.length === 0) {
    logInfo("[DailySummary] No interactions to summarize for", targetDate);
    return null;
  }

  logInfo("[DailySummary] Found", interactions.length, "interactions to summarize");

  // Load current profile for context
  const currentProfile = await loadProfile();

  try {
    // Use the embedded agent backend to generate summary and extract facts
    const client = await getAgentClient();

    const prompt = `You are summarizing a day's worth of conversations between a user and their AI assistant Ari.

TARGET DATE: ${targetDate}

First, retrieve the day's context using the safe memory tools. Use 'get_day_summary' if a summary already exists, 'get_recent_conversations' for session context, and 'search_memory' with keywords from the day if you need supporting evidence. The target date is ${targetDate} (${dateStringToInt(targetDate)}).

After reviewing the conversations, provide:
1. A brief summary of what was discussed today (2-3 sentences)
2. A list of 3-7 key topics/tasks discussed (short phrases)
3. Any new facts learned about the user that should be remembered

Respond with ONLY this JSON format:
{
  "summary": "Brief summary here",
  "topics": ["Topic 1", "Topic 2", "Topic 3"],
  "profileUpdates": {
    "personalInfo": { "name": null, "preferredName": null, "location": null },
    "preferences": {},
    "schedulePatterns": {},
    "interests": [],
    "relationships": {},
    "notes": []
  }
}

Current user profile for context:
- Name: ${currentProfile.personalInfo.name || "unknown"}
- Location: ${currentProfile.personalInfo.location || "unknown"}
- Interests: ${currentProfile.interests.join(", ") || "none recorded"}

CRITICAL RULES:
- NEVER make up or infer facts that weren't explicitly stated by the user
- Only include information the user directly told you (e.g., "I live in Florida" = location: Florida)
- If something wasn't explicitly mentioned, leave it as null or don't include it
- Do NOT guess names, preferences, or any other details
- When in doubt, leave it out

Only include profile updates for NEW information learned today. Leave fields as null or empty if no new info.
After querying and reviewing the conversations, respond with ONLY the JSON.`;

    const response = await client.query({ query: prompt });

    // Parse the response
    let summary: string;
    let topics: string[] = [];
    let profileUpdates: Partial<UserProfile> | null = null;

    try {
      // Try to parse as JSON
      const parsed = JSON.parse(response.response);
      summary = parsed.summary || response.response;
      topics = parsed.topics || [];

      if (parsed.profileUpdates) {
        // Filter out null/empty values
        profileUpdates = filterEmptyProfileUpdates(parsed.profileUpdates);
      }
    } catch {
      // If not valid JSON, just use the response as summary
      summary = response.response;
    }

    // Save to database
    saveDailySummary({
      date: targetDate,
      summary,
      interactionCount: interactions.length,
    });

    // Update profile if we extracted new facts and profile learning is enabled.
    if (memorySettings.profileLearningEnabled && profileUpdates && hasProfileUpdates(profileUpdates)) {
      await updateProfile(profileUpdates);
      logInfo("[DailySummary] Updated user profile with new facts");
    }

    // Save markdown file (summary only - full conversations can be queried via SQL)
    const mdPath = join(getDailyDir(), `${targetDate}.md`);
    const dateInt = dateStringToInt(targetDate);
    const topicsList = topics.length > 0
      ? topics.map(t => `- ${t}`).join('\n')
      : '- No specific topics recorded';
    const mdContent = `# Daily Summary - ${targetDate}

## Summary
${summary}

## Topics Discussed
${topicsList}

## Statistics
- Total interactions: ${interactions.length}
- User messages: ${interactions.filter((i) => i.role === "user").length}
- Ari responses: ${interactions.filter((i) => i.role === "assistant").length}

## Query Details
To retrieve the full conversation log for this day (with readable timestamps):
\`\`\`sql
SELECT * FROM interactions_readable WHERE date = ${dateInt}
\`\`\`
`;

    let savedToFile = false;
    try {
      await writeFile(mdPath, mdContent, "utf-8");
      savedToFile = true;
      logDebug("[DailySummary] Saved summary to", mdPath);
    } catch (error) {
      logError("[DailySummary] Failed to save markdown file:", error);
    }

    logInfo("[DailySummary] Summary generated successfully");

    return {
      date: targetDate,
      summary,
      interactionCount: interactions.length,
      profileUpdates,
      savedToFile,
    };
  } catch (error) {
    logError("[DailySummary] Failed to generate summary:", error);

    // Save a basic summary even if LLM fails
    const basicSummary = `Had ${interactions.length} interactions today.`;
    saveDailySummary({
      date: targetDate,
      summary: basicSummary,
      interactionCount: interactions.length,
    });

    return {
      date: targetDate,
      summary: basicSummary,
      interactionCount: interactions.length,
      profileUpdates: null,
      savedToFile: false,
    };
  }
}

/**
 * Filter out empty/null profile updates
 */
function filterEmptyProfileUpdates(updates: Record<string, unknown>): Partial<UserProfile> {
  const filtered: Partial<UserProfile> = {};

  if (updates.personalInfo) {
    const pi = updates.personalInfo as Record<string, unknown>;
    const personalInfo: UserProfile["personalInfo"] = {};
    if (pi.name) personalInfo.name = String(pi.name);
    if (pi.preferredName) personalInfo.preferredName = String(pi.preferredName);
    if (pi.location) personalInfo.location = String(pi.location);
    if (Object.keys(personalInfo).length > 0) {
      filtered.personalInfo = personalInfo;
    }
  }

  if (updates.preferences && typeof updates.preferences === "object") {
    const prefs = updates.preferences as Record<string, unknown>;
    const preferences: UserProfile["preferences"] = {};
    for (const [key, value] of Object.entries(prefs)) {
      if (value) preferences[key] = String(value);
    }
    if (Object.keys(preferences).length > 0) {
      filtered.preferences = preferences;
    }
  }

  if (updates.schedulePatterns && typeof updates.schedulePatterns === "object") {
    const sp = updates.schedulePatterns as Record<string, unknown>;
    const schedulePatterns: UserProfile["schedulePatterns"] = {};
    for (const [key, value] of Object.entries(sp)) {
      if (value) schedulePatterns[key] = String(value);
    }
    if (Object.keys(schedulePatterns).length > 0) {
      filtered.schedulePatterns = schedulePatterns;
    }
  }

  if (Array.isArray(updates.interests) && updates.interests.length > 0) {
    filtered.interests = updates.interests.map(String);
  }

  if (updates.relationships && typeof updates.relationships === "object") {
    const rels = updates.relationships as Record<string, unknown>;
    const relationships: UserProfile["relationships"] = {};
    for (const [key, value] of Object.entries(rels)) {
      if (value) relationships[key] = String(value);
    }
    if (Object.keys(relationships).length > 0) {
      filtered.relationships = relationships;
    }
  }

  if (Array.isArray(updates.notes) && updates.notes.length > 0) {
    filtered.notes = updates.notes.map(String);
  }

  return filtered;
}

/**
 * Check if profile updates contain any actual changes
 */
function hasProfileUpdates(updates: Partial<UserProfile>): boolean {
  return !!(
    (updates.personalInfo && Object.keys(updates.personalInfo).length > 0) ||
    (updates.preferences && Object.keys(updates.preferences).length > 0) ||
    (updates.schedulePatterns && Object.keys(updates.schedulePatterns).length > 0) ||
    (updates.interests && updates.interests.length > 0) ||
    (updates.relationships && Object.keys(updates.relationships).length > 0) ||
    (updates.notes && updates.notes.length > 0)
  );
}

/**
 * Check if it's time for daily summary (end of day)
 * Returns true if it's after 10 PM and no summary exists for today
 */
export function shouldRunDailySummary(): boolean {
  const now = new Date();
  const hour = now.getHours();

  // Only run after 10 PM
  if (hour < 22) {
    return false;
  }

  // Check if summary already exists
  const today = getTodayDateString();
  const existing = getDailySummary(today);

  return !existing;
}

/**
 * Get summary status for today
 */
export function getDailySummaryStatus(): {
  date: string;
  hasSummary: boolean;
  interactionCount: number;
} {
  const today = getTodayDateString();
  const existing = getDailySummary(today);
  const count = getInteractionCount({
    startTime: new Date().setHours(0, 0, 0, 0),
  });

  return {
    date: today,
    hasSummary: !!existing,
    interactionCount: count,
  };
}

