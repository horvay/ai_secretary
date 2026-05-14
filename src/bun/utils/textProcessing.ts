/**
 * Text Processing Utilities
 * Functions for processing text before TTS synthesis
 */

/**
 * Silent response prefix - when Ari wants to acknowledge without speaking
 */
const NO_RESPONSE_PREFIX = "[NO_RESPONSE]";

/**
 * One-shot animation marker format emitted inline by the assistant:
 *   [anim:<key>]
 *
 * We strip these markers from display + TTS, but use them as signals to trigger
 * one-shot avatar overrides without using a blocking tool call.
 */
const ANIM_MARKER_RE = /\[anim:([a-zA-Z0-9._-]{1,80})\]/g;

/**
 * Strips both complete and partial anim markers from text.
 * Partial markers are only stripped if they are at the end of the string.
 */
const ANIM_MARKER_STRIP_RE = /\[anim:([a-zA-Z0-9._-]{0,80})(?:\]|$)/g;
/**
 * Avatar status marker format emitted inline by the assistant:
 *   [state:<status>]
 */
const STATE_MARKER_RE = /\[state:([a-zA-Z0-9._-]{1,80})\]/g;
const STATE_MARKER_STRIP_RE = /\[state:([a-zA-Z0-9._-]{0,80})(?:\]|$)/g;
/**
 * Looser versions to strip malformed or partially streamed markers from display.
 * These should NOT be used for triggering actions, only for cleaning text.
 */
const ANIM_MARKER_LOOSE_STRIP_RE = /\[anim[^\]]*(?:\]|$)/gi;
const STATE_MARKER_LOOSE_STRIP_RE = /\[state[^\]]*(?:\]|$)/gi;
/**
 * Token-based stripper for malformed markers like:
 *   "[anim I'm..." or "[state normal..."
 * Removes the marker token but leaves the rest of the text intact.
 */
const ANIM_MARKER_TOKEN_STRIP_RE = /\[anim\b\s*:?\s*(?:[a-zA-Z0-9._-]{1,80})?\s*\]?/gi;
const STATE_MARKER_TOKEN_STRIP_RE = /\[state\b\s*:?\s*(?:[a-zA-Z0-9._-]{1,80})?\s*\]?/gi;
/**
 * Generic bracket tag stripper for TTS.
 *
 * We treat anything inside square brackets as a control tag / non-speakable metadata
 * (e.g., [anim:dance], [NO_RESPONSE], [thinking], etc.).
 *
 * NOTE: This is intentionally broad: it removes ALL well-formed [...] segments.
 *
 * We also strip partial brackets at the end of a string to avoid TTS saying "bracket"
 * when a tag is still streaming.
 */
const SQUARE_BRACKET_SEGMENT_RE = /\[[^\]]*?\]|\[[^\]]*$/g;

export type AnimMarkerMatch = { key: string; index: number; raw: string };
export type StateMarkerMatch = { status: string; index: number; raw: string };

export function findAnimMarkers(text: string): AnimMarkerMatch[] {
  // matchAll requires a non-global regex OR a fresh global regex; use a fresh one.
  const re = new RegExp(ANIM_MARKER_RE.source, "g");
  const matches: AnimMarkerMatch[] = [];
  for (const m of text.matchAll(re)) {
    const raw = m[0] ?? "";
    const key = String(m[1] ?? "");
    const index = typeof m.index === "number" ? m.index : -1;
    if (!raw || !key || index < 0) continue;
    matches.push({ key, index, raw });
  }
  return matches;
}

export function stripAnimMarkers(text: string): string {
  return text.replace(ANIM_MARKER_STRIP_RE, "");
}

export function findStateMarkers(text: string): StateMarkerMatch[] {
  const re = new RegExp(STATE_MARKER_RE.source, "g");
  const matches: StateMarkerMatch[] = [];
  for (const m of text.matchAll(re)) {
    const raw = m[0] ?? "";
    const status = String(m[1] ?? "");
    const index = typeof m.index === "number" ? m.index : -1;
    if (!raw || !status || index < 0) continue;
    matches.push({ status, index, raw });
  }
  return matches;
}

export function stripStateMarkers(text: string): string {
  return text.replace(STATE_MARKER_STRIP_RE, "");
}

export function stripLooseAnimStateMarkers(text: string): string {
  return text.replace(ANIM_MARKER_LOOSE_STRIP_RE, "").replace(STATE_MARKER_LOOSE_STRIP_RE, "");
}

export function stripAnimStateMarkerTokens(text: string): string {
  return text.replace(ANIM_MARKER_TOKEN_STRIP_RE, "").replace(STATE_MARKER_TOKEN_STRIP_RE, "");
}

/**
 * Strip any well-formed square-bracketed segments from text.
 * Example: "Hi [anim:dance] there" -> "Hi  there"
 */
export function stripSquareBracketSegments(text: string): string {
  return text.replace(SQUARE_BRACKET_SEGMENT_RE, "");
}

/**
 * Check if a response should be silent (no TTS)
 * Checks for [NO_RESPONSE] at the start of trimmed text OR anywhere in the text
 * @param text - The response text to check
 * @returns true if the response should be silent
 */
export function isSilentResponse(text: string): boolean {
  const trimmed = text.trim();
  // Check if it starts with the prefix
  if (trimmed.startsWith(NO_RESPONSE_PREFIX)) {
    return true;
  }
  // Also check if it contains the prefix anywhere (in case AI puts it after thinking tags)
  if (trimmed.includes(NO_RESPONSE_PREFIX)) {
    return true;
  }
  return false;
}

/**
 * Strip the silent response prefix from text
 * @param text - The text to strip
 * @returns Text without the prefix
 */
export function stripSilentPrefix(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith(NO_RESPONSE_PREFIX)) {
    return trimmed.slice(NO_RESPONSE_PREFIX.length).trim();
  }
  return text;
}

/**
 * Remove <think>...</think> blocks and orphaned </think> tags from AI responses.
 * This handles both complete blocks and partial/streaming content.
 * @param text - The text to clean
 * @param preserveWhitespace - If true, don't normalize/trim whitespace (for streaming deltas)
 * @returns Text with thinking content removed
 */
export function removeThinkingTags(text: string, preserveWhitespace: boolean = false): string {
  // Remove complete <think>...</think> blocks (including multiline)
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "");

  // Remove orphaned </think> tags (when opening tag was already removed or in streaming)
  cleaned = cleaned.replace(/<\/think>/gi, "");

  // Remove orphaned <think> tags at the start (incomplete thinking block still being streamed)
  // We also remove any content after an unclosed <think> since it's still "thinking"
  const thinkStartIndex = cleaned.toLowerCase().indexOf("<think>");
  if (thinkStartIndex !== -1) {
    // Keep only content before the <think> tag
    cleaned = cleaned.substring(0, thinkStartIndex);
  }

  // Normalize whitespace that may have been left behind (unless preserving for streaming)
  if (!preserveWhitespace) {
    cleaned = cleaned.replace(/\s+/g, " ").trim();
  }

  return cleaned;
}

/**
 * Clean AI response text for display (removes internal tags but not [NO_RESPONSE])
 * This should be called on text before showing in UI.
 * @param text - The raw AI response text
 * @returns Cleaned text suitable for display
 */
export function cleanResponseForDisplay(text: string): string {
  // Preserve newlines for chat bubble rendering; only strip control markers.
  let cleaned = removeThinkingTags(text, true);

  // Strip NO_RESPONSE prefix if present (the text should still be displayed without the prefix)
  cleaned = stripSilentPrefix(cleaned);
  cleaned = stripLooseAnimStateMarkers(stripAnimStateMarkerTokens(stripStateMarkers(stripAnimMarkers(cleaned))));

  // Trim leading whitespace/newlines that may remain after stripping tags/markers
  cleaned = cleaned.trimStart();

  return cleaned;
}

/**
 * Clean a streaming delta for display while preserving whitespace.
 * IMPORTANT: Preserve leading/trailing whitespace so streamed text doesn't collapse.
 */
export function cleanDeltaForDisplay(delta: string): string {
  const noThink = removeThinkingTags(delta, true);
  const noSilent = stripSilentPrefix(noThink);
  return stripLooseAnimStateMarkers(stripAnimStateMarkerTokens(stripStateMarkers(stripAnimMarkers(noSilent))));
}

/**
 * Clean a streaming delta for TTS buffering.
 * IMPORTANT: Preserves leading/trailing whitespace so sentence buffer works correctly.
 * @param delta - The streaming text delta
 * @returns Cleaned delta with whitespace preserved
 */
export function cleanDeltaForTTS(delta: string): string {
  // Preserve whitespace for sentence buffering, but remove non-speakable tags.
  // - Thinking tags are internal.
  // - Square bracket segments are control/meta markers and should never be spoken.
  const noThink = removeThinkingTags(delta, true);
  const noMarkers = stripLooseAnimStateMarkers(stripAnimStateMarkerTokens(noThink));
  return stripSquareBracketSegments(noMarkers);
}

/**
 * Estimate duration from text (fallback when WAV parsing fails)
 */
export function estimateDuration(text: string): number {
  // Average speaking rate: ~150 words per minute
  // Average word length: ~5 characters
  const wordCount = text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
  const duration = (wordCount / 150) * 60; // seconds
  return Math.max(duration, 0.5); // Minimum 0.5 seconds
}

/**
 * Elongate vowels before ~ (e.g., "nya~" -> "nyaaaa", "there!~" -> "thereee!")
 * Finds the last vowel in the word before ~ and elongates it
 * Also removes the ~ after elongation so it's not spoken
 */
export function elongateVowels(text: string): string {
  // Match word characters (letters) followed by optional punctuation and then ~
  // This handles cases like "there!~" or "nya~"
  return text.replace(/([a-zA-Z]+)([!?.]*?)~/g, (match, word, punctuation) => {
    // Find the last vowel in the word
    const lastVowelIndex = word.search(/([aeiouAEIOU])[^aeiouAEIOU]*$/);
    if (lastVowelIndex !== -1) {
      const lastVowel = word[lastVowelIndex];
      // Replace the last vowel with 3 more of the same vowel (total 4)
      const elongatedWord =
        word.substring(0, lastVowelIndex) + lastVowel.repeat(4) + word.substring(lastVowelIndex + 1);
      return elongatedWord + punctuation; // ~ is removed by not including it in the replacement
    }
    return match; // Fallback if no vowel found
  });
}

/**
 * Remove emojis from text
 */
export function removeEmojis(text: string): string {
  // Remove emoji characters (Unicode ranges for emojis)
  return text
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, "") // Emoticons, symbols, pictographs
    .replace(/[\u{1F600}-\u{1F64F}]/gu, "") // Emoticons
    .replace(/[\u{1F680}-\u{1F6FF}]/gu, "") // Transport and map symbols
    .replace(/[\u{2600}-\u{26FF}]/gu, "") // Miscellaneous symbols
    .replace(/[\u{2700}-\u{27BF}]/gu, "") // Dingbats
    .replace(/[\u{1F900}-\u{1F9FF}]/gu, "") // Supplemental symbols and pictographs
    .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, "") // Regional indicator symbols (flags)
    .replace(/[\u{200D}]/gu, "") // Zero-width joiner
    .replace(/[\u{FE0F}]/gu, ""); // Variation selector-16
}

/**
 * Split text into sentences for natural chunking
 */
export function splitIntoSentences(text: string): string[] {
  // Clean the text (remove formatting characters that shouldn't affect sentence splitting)
  const cleaned = text.trim();

  // Split on sentence-ending punctuation, but keep the punctuation
  // This regex matches: . ! ? followed by space or end of string
  const sentences: string[] = [];
  let current = "";

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    current += char;

    // Check for sentence endings
    if (
      (char === "." || char === "!" || char === "?") &&
      (i === cleaned.length - 1 || cleaned[i + 1] === " " || cleaned[i + 1] === "\n")
    ) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        sentences.push(trimmed);
        current = "";
        // Skip the following space if present
        if (i < cleaned.length - 1 && cleaned[i + 1] === " ") {
          i++;
        }
      }
    }
  }

  // Add any remaining text
  const remaining = current.trim();
  if (remaining.length > 0) {
    sentences.push(remaining);
  }

  // If no sentences were found (no punctuation), return the whole text
  return sentences.length > 0 ? sentences : [cleaned];
}

/**
 * Clean text for TTS by removing formatting characters silently
 */
export function cleanTextForTTS(text: string): string {
  // Remove standalone asterisks and tildes silently (they're not spoken)
  return stripSquareBracketSegments(text)
    .replace(/\*/g, "") // Remove asterisks
    .replace(/~/g, "") // Remove tildes (vowel elongation already processed)
    .trim();
}

/**
 * Full text cleaning pipeline for TTS
 * Applies all text transformations needed before synthesis
 */
export function prepareTextForTTS(text: string): string {
  let cleaned = stripSquareBracketSegments(text)
    .replace(/\n\s*\n/g, " ... ") // Add pause for paragraph breaks (double newlines)
    .replace(/[\r\n]+/g, " ") // Replace remaining newlines with spaces
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();

  // Elongate vowels before ~ (e.g., "nya~" -> "nyaaaa")
  // This also removes the ~ after elongation
  cleaned = elongateVowels(cleaned);

  // Remove any remaining formatting characters silently (asterisks, tildes)
  // These shouldn't be spoken as "asterisk" or "tilde"
  cleaned = cleaned
    .replace(/\*/g, "") // Remove asterisks
    .replace(/~/g, ""); // Remove any remaining tildes

  // Remove emojis
  cleaned = removeEmojis(cleaned)
    .replace(/\s+/g, " ") // Re-normalize whitespace after emoji removal
    .trim();

  return cleaned;
}

