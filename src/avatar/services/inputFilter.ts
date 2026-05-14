/**
 * Voice input hygiene helpers.
 * Semantic directedness is intentionally not decided locally; meaningful speech
 * is routed to Ari's JSON voice decision layer.
 */

const MIN_MEANINGFUL_LENGTH = 3;

const NOISE_PHRASES = [
  "um",
  "uh",
  "hmm",
  "ah",
  "oh",
  "huh",
  "mm",
  "mhm",
  "uh-huh",
];

const SHORT_ACKNOWLEDGEMENTS = [
  "yeah",
  "yep",
  "nope",
  "no",
  "yes",
  "okay",
  "ok",
];

export function shouldDropAsVoiceNoise(
  text: string,
  options: { isFollowupMode?: boolean } = {},
): boolean {
  const normalized = text.toLowerCase().trim();
  if (normalized.length < MIN_MEANINGFUL_LENGTH) {
    return !options.isFollowupMode || normalized.length === 0 || !SHORT_ACKNOWLEDGEMENTS.includes(normalized);
  }

  if (NOISE_PHRASES.includes(normalized)) return true;
  if (!options.isFollowupMode && SHORT_ACKNOWLEDGEMENTS.includes(normalized)) return true;
  return false;
}
