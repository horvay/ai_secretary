/**
 * OCR Service for Ari
 * Extracts text from screenshots for searchability
 *
 * Note: Currently uses a placeholder implementation.
 * For production, consider integrating Tesseract.js or a cloud OCR service.
 */

import { join } from "path";
import { readFile } from "fs/promises";
import { getScreenshotsDir } from "../db";
import { updateScreenshotOcr, getScreenshot } from "./memory";
import { logInfo, logError, logDebug, logWarn } from "../utils/logger";

/**
 * OCR result
 */
export interface OcrResult {
  text: string;
  confidence: number;
  language?: string;
}

/**
 * OCR service state
 */
interface OcrState {
  initialized: boolean;
  // Tesseract worker would go here in a full implementation
}

const state: OcrState = {
  initialized: false,
};

/**
 * Initialize the OCR service
 * In a full implementation, this would load Tesseract.js
 */
export async function initOcr(): Promise<void> {
  if (state.initialized) {
    return;
  }

  logInfo("[OCR] Initializing OCR service...");

  // Placeholder - in full implementation:
  // - Load Tesseract.js worker
  // - Download language data if needed

  state.initialized = true;
  logInfo("[OCR] OCR service initialized (placeholder mode)");
}

/**
 * Shutdown the OCR service
 */
export async function shutdownOcr(): Promise<void> {
  if (!state.initialized) {
    return;
  }

  // Placeholder - in full implementation:
  // - Terminate Tesseract worker

  state.initialized = false;
  logInfo("[OCR] OCR service shut down");
}

/**
 * Extract text from an image buffer
 *
 * PLACEHOLDER IMPLEMENTATION
 * In production, replace with actual Tesseract.js integration:
 *
 * ```typescript
 * import { createWorker } from 'tesseract.js';
 *
 * const worker = await createWorker('eng');
 * const { data } = await worker.recognize(imageBuffer);
 * return {
 *   text: data.text,
 *   confidence: data.confidence / 100,
 * };
 * ```
 */
export async function extractTextFromBuffer(imageBuffer: Buffer): Promise<OcrResult> {
  if (!state.initialized) {
    await initOcr();
  }

  logDebug("[OCR] Extracting text from image buffer...");

  // PLACEHOLDER: Return empty result
  // In production, use Tesseract.js here
  logWarn("[OCR] Using placeholder OCR - no actual text extraction");

  return {
    text: "",
    confidence: 0,
    language: "eng",
  };
}

/**
 * Extract text from a screenshot file by its key
 */
export async function extractTextFromScreenshot(fileKey: string): Promise<OcrResult | null> {
  try {
    // Check if screenshot exists in database
    const screenshot = getScreenshot(fileKey);
    if (!screenshot) {
      logError("[OCR] Screenshot not found:", fileKey);
      return null;
    }

    // If OCR already done, return cached result
    if (screenshot.ocr_text) {
      logDebug("[OCR] Using cached OCR for:", fileKey);
      return {
        text: screenshot.ocr_text,
        confidence: 1, // Cached, assumed correct
      };
    }

    // Read the image file
    const imagePath = join(getScreenshotsDir(), fileKey);
    const imageBuffer = await readFile(imagePath);

    // Extract text
    const result = await extractTextFromBuffer(imageBuffer);

    // Cache the result in database
    if (result.text) {
      updateScreenshotOcr(fileKey, result.text);
    }

    return result;
  } catch (error) {
    logError("[OCR] Failed to extract text from screenshot:", error);
    return null;
  }
}

/**
 * Batch process screenshots that don't have OCR text yet
 */
export async function processUnprocessedScreenshots(limit: number = 10): Promise<number> {
  // This would query for screenshots without OCR text and process them
  // Placeholder implementation
  logDebug("[OCR] processUnprocessedScreenshots called (placeholder)");
  return 0;
}

/**
 * Check if OCR is available
 * In placeholder mode, always returns true but won't extract text
 */
export function isOcrAvailable(): boolean {
  return state.initialized;
}

/**
 * Get OCR service status
 */
export function getOcrStatus(): {
  initialized: boolean;
  available: boolean;
  mode: "placeholder" | "tesseract" | "cloud";
} {
  return {
    initialized: state.initialized,
    available: true, // Placeholder is always "available"
    mode: "placeholder", // Change when real OCR is implemented
  };
}

