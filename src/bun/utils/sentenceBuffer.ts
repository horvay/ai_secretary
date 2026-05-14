/**
 * Streaming Sentence Buffer
 * Incrementally detects sentence boundaries as text streams in.
 * Used for streaming TTS - we process sentences in batches as they arrive.
 */

import { logDebug } from "./logger";

export interface SentenceBufferResult {
  completeSentences: string[];
  remainder: string;
}

export interface SentenceBufferOptions {
  /** Minimum sentences to accumulate before returning (default: 2) */
  minSentences?: number;
  /** Word count that triggers a batch even if sentence count not met (default: 250) */
  wordCountFailsafe?: number;
}

/**
 * Count words in a string
 */
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}

/**
 * Check if a period is likely an abbreviation, not end of sentence
 * Common abbreviations that shouldn't end sentences
 */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr',
  'vs', 'etc', 'inc', 'ltd', 'co',
  'st', 'ave', 'blvd', 'rd',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
  'i.e', 'e.g', 'cf', 'al', 'approx',
]);

function isAbbreviation(word: string): boolean {
  // Remove the trailing period and check
  const clean = word.toLowerCase().replace(/\.$/, '');
  return ABBREVIATIONS.has(clean);
}

/**
 * Streaming sentence buffer for incremental TTS processing
 */
export class StreamingSentenceBuffer {
  private buffer: string = "";
  private options: Required<SentenceBufferOptions>;

  constructor(options: SentenceBufferOptions = {}) {
    this.options = {
      minSentences: options.minSentences ?? 2,
      wordCountFailsafe: options.wordCountFailsafe ?? 250,
    };
  }

  /**
   * Append incoming text to the buffer
   */
  append(text: string): void {
    this.buffer += text;
  }

  /**
   * Get the current buffer contents (for debugging/display)
   */
  getBuffer(): string {
    return this.buffer;
  }

  /**
   * Get word count of current buffer
   */
  getWordCount(): number {
    return countWords(this.buffer);
  }

  /**
   * Extract complete sentences from the buffer.
   * Returns sentences only when we have enough (minSentences or wordCountFailsafe).
   *
   * @param force - If true, return whatever we have (for final flush)
   */
  extractSentences(force: boolean = false): SentenceBufferResult {
    const sentences: string[] = [];
    let current = "";
    let i = 0;

    // First, clean the buffer for sentence detection - remove asterisks/tildes silently
    // Add pause markers for paragraph breaks
    const cleanedBuffer = this.buffer
      .replace(/\n\s*\n/g, " ... ") // Add pause for paragraph breaks
      .replace(/\*/g, "") // Remove asterisks silently
      .replace(/~/g, "") // Remove tildes silently
      .trim();

    while (i < cleanedBuffer.length) {
      const char = cleanedBuffer[i];
      current += char;

      // Check for sentence endings: . ! ?
      if (char === "." || char === "!" || char === "?") {
        // Look ahead - is this followed by space, newline, or end of string?
        const nextChar = cleanedBuffer[i + 1];
        const isEndOfString = i === cleanedBuffer.length - 1;
        const isFollowedBySpace = nextChar === " " || nextChar === "\n" || nextChar === "\r";

        if (isEndOfString || isFollowedBySpace) {
          // Check if this is an abbreviation (for periods only)
          if (char === ".") {
            // Get the word before the period
            const words = current.trim().split(/\s+/);
            const lastWord = words[words.length - 1];

            if (isAbbreviation(lastWord)) {
              i++;
              continue; // Not a sentence end, continue
            }
          }

          // This is a sentence end
          const trimmed = current.trim();
          if (trimmed.length > 0) {
            sentences.push(trimmed);
            current = "";

            // Skip following whitespace
            while (i + 1 < cleanedBuffer.length &&
                   (cleanedBuffer[i + 1] === " " || cleanedBuffer[i + 1] === "\n")) {
              i++;
            }
          }
        }
      }

      i++;
    }

    // Whatever's left is the remainder (incomplete sentence)
    const remainder = current.trim();

    // Calculate metrics
    const totalSentences = sentences.length;
    const totalWords = countWords(sentences.join(" "));
    const remainderWords = countWords(remainder);

    // Determine if we should return sentences
    const hasEnoughSentences = totalSentences >= this.options.minSentences;
    const hasEnoughWords = totalWords >= this.options.wordCountFailsafe;
    const shouldReturn = force || hasEnoughSentences || hasEnoughWords;

    if (shouldReturn && sentences.length > 0) {
      // Update buffer to only contain the remainder
      this.buffer = remainder;

      return {
        completeSentences: sentences,
        remainder,
      };
    }

    // Not enough yet, return nothing
    return {
      completeSentences: [],
      remainder: this.buffer,
    };
  }

  /**
   * Flush all remaining content as sentences (for end of stream)
   */
  flush(): string[] {
    const result = this.extractSentences(true);

    // If there's still a remainder, treat it as a final sentence
    if (result.remainder.length > 0) {
      const finalSentences = [...result.completeSentences];
      // Clean the remainder - remove formatting chars silently
      const cleanedRemainder = result.remainder
        .replace(/\n\s*\n/g, " ... ") // Add pause for paragraph breaks
        .replace(/\*/g, "") // Remove asterisks silently
        .replace(/~/g, "") // Remove tildes silently
        .trim();
      if (cleanedRemainder.length > 0) {
        finalSentences.push(cleanedRemainder);
      }
      this.buffer = "";
      return finalSentences;
    }

    this.buffer = "";
    return result.completeSentences;
  }

  /**
   * Clear the buffer entirely
   */
  clear(): void {
    this.buffer = "";
  }

  /**
   * Prepend sentences back onto the buffer (used to limit TTS batch size).
   */
  prependSentences(sentences: string[]): void {
    if (!sentences || sentences.length === 0) return;
    const text = sentences.join(" ").trim();
    if (!text) return;
    if (this.buffer.trim().length === 0) {
      this.buffer = text;
    } else {
      this.buffer = `${text} ${this.buffer}`;
    }
  }

  /**
   * Check if buffer has any content
   */
  isEmpty(): boolean {
    return this.buffer.trim().length === 0;
  }

  /**
   * Check if we have enough content to process
   * (2+ sentences or 250+ words)
   * This is a read-only check that doesn't modify the buffer
   */
  isReadyForProcessing(): boolean {
    const cleanedBuffer = this.buffer
      .replace(/\*/g, "") // Remove asterisks silently
      .replace(/~/g, "") // Remove tildes silently
      .trim();

    if (!cleanedBuffer) return false;

    // Count complete sentences in buffer
    let sentenceCount = 0;
    let wordsInCompleteSentences = 0;
    let current = "";

    for (let i = 0; i < cleanedBuffer.length; i++) {
      const char = cleanedBuffer[i];
      current += char;

      if (char === "." || char === "!" || char === "?") {
        const nextChar = cleanedBuffer[i + 1];
        const isEnd = i === cleanedBuffer.length - 1 || nextChar === " " || nextChar === "\n" || nextChar === "\r";

        if (isEnd) {
          // Check for abbreviation (periods only)
          if (char === ".") {
            const words = current.trim().split(/\s+/);
            const lastWord = words[words.length - 1];
            if (isAbbreviation(lastWord)) {
              continue; // Not a sentence end
            }
          }

          const trimmed = current.trim();
          if (trimmed.length > 0) {
            sentenceCount++;
            wordsInCompleteSentences += countWords(trimmed);
            current = "";
          }
        }
      }
    }

    const ready = sentenceCount >= this.options.minSentences ||
                  wordsInCompleteSentences >= this.options.wordCountFailsafe;

    if (ready) {
      logDebug(`📊 Sentence buffer ready: ${sentenceCount} sentences, ${wordsInCompleteSentences} words`);
    }

    return ready;
  }
}

/**
 * Create a new streaming sentence buffer
 */
export function createSentenceBuffer(options?: SentenceBufferOptions): StreamingSentenceBuffer {
  return new StreamingSentenceBuffer(options);
}

