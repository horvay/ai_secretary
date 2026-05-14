/**
 * Parakeet Model Downloader Service
 * Downloads parakeet.js model files to disk and serves them locally
 */

import { mkdir, writeFile, access, readdir, stat } from "fs/promises";
import { join } from "path";
import { createServer } from "http";
import { logDebug, logInfo, logWarn, logError } from "../utils/logger";
import { getAiSecretaryDataDir } from "../utils/paths";

// Constants
const DATA_DIR = getAiSecretaryDataDir();
const PARAKET_MODELS_DIR = join(DATA_DIR, "parakeet-models");
const REPO_ID = "istupakov/parakeet-tdt-0.6b-v2-onnx";

// Model files we need to download
interface ModelFiles {
  encoderUrl: string;
  decoderUrl: string;
  encoderDataUrl: string | null;
  decoderDataUrl: string | null;
  tokenizerUrl: string;
  preprocessorUrl: string;
}

interface ModelFileInfo {
  filename: string;
  url: string;
  localPath: string;
}

/**
 * Ensure models directory exists
 */
async function ensureDirectory(): Promise<void> {
  try {
    await mkdir(PARAKET_MODELS_DIR, { recursive: true });
  } catch (error) {
    if (error instanceof Error && !error.message.includes("EEXIST")) {
      throw new Error(`Failed to create models directory: ${error.message}`);
    }
  }
}

/**
 * Check if file exists
 */
async function fileExists(filepath: string): Promise<boolean> {
  try {
    await access(filepath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Download file using fetch
 */
async function downloadFile(url: string, outputPath: string, onProgress?: (loaded: number, total: number) => void): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const contentLength = response.headers.get("content-length");
  const total = contentLength ? parseInt(contentLength, 10) : 0;
  let loaded = 0;

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Response body is not readable");
  }

  const { createWriteStream } = await import("fs");
  const fileStream = createWriteStream(outputPath);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const buffer = Buffer.from(value);
      const canWrite = fileStream.write(buffer);

      // If the write buffer is full, wait for it to drain before reading more from network
      // This prevents memory spikes during large file downloads (like the 622MB model)
      if (!canWrite) {
        await new Promise((resolve) => fileStream.once("drain", resolve));
      }

      loaded += value.length;

      if (onProgress && total > 0) {
        onProgress(loaded, total);
      }
    }
  } finally {
    fileStream.end();
    // Wait for the stream to finish writing
    await new Promise((resolve) => fileStream.on("finish", resolve));
  }
}

/**
 * Get HuggingFace file URL
 */
function getHuggingFaceUrl(repoId: string, filename: string, revision: string = "main"): string {
  return `https://huggingface.co/${repoId}/resolve/${revision}/${filename}`;
}

/**
 * Get list of files needed for the model
 */
function getModelFiles(encoderQuant: "fp32" | "int8", decoderQuant: "fp32" | "int8", preprocessor: "nemo128" | "nemo80"): ModelFileInfo[] {
  const encoderSuffix = encoderQuant === "int8" ? ".int8.onnx" : ".onnx";
  const decoderSuffix = decoderQuant === "int8" ? ".int8.onnx" : ".onnx";

  const encoderName = `encoder-model${encoderSuffix}`;
  const decoderName = `decoder_joint-model${decoderSuffix}`;

  const files: ModelFileInfo[] = [
    {
      filename: encoderName,
      url: getHuggingFaceUrl(REPO_ID, encoderName),
      localPath: join(PARAKET_MODELS_DIR, encoderName),
    },
    {
      filename: `${encoderName}.data`,
      url: getHuggingFaceUrl(REPO_ID, `${encoderName}.data`),
      localPath: join(PARAKET_MODELS_DIR, `${encoderName}.data`),
    },
    {
      filename: decoderName,
      url: getHuggingFaceUrl(REPO_ID, decoderName),
      localPath: join(PARAKET_MODELS_DIR, decoderName),
    },
    {
      filename: `${decoderName}.data`,
      url: getHuggingFaceUrl(REPO_ID, `${decoderName}.data`),
      localPath: join(PARAKET_MODELS_DIR, `${decoderName}.data`),
    },
    {
      filename: "vocab.txt",
      url: getHuggingFaceUrl(REPO_ID, "vocab.txt"),
      localPath: join(PARAKET_MODELS_DIR, "vocab.txt"),
    },
    {
      filename: `${preprocessor}.onnx`,
      url: getHuggingFaceUrl(REPO_ID, `${preprocessor}.onnx`),
      localPath: join(PARAKET_MODELS_DIR, `${preprocessor}.onnx`),
    },
  ];

  return files;
}

/**
 * Check if model files are downloaded
 */
export async function areModelFilesDownloaded(encoderQuant: "fp32" | "int8" = "int8", decoderQuant: "fp32" | "int8" = "int8", preprocessor: "nemo128" | "nemo80" = "nemo128"): Promise<boolean> {
  const files = getModelFiles(encoderQuant, decoderQuant, preprocessor);

  for (const file of files) {
    if (!(await fileExists(file.localPath))) {
      return false;
    }
  }

  return true;
}

/**
 * Download model files
 */
export async function downloadModelFiles(
  encoderQuant: "fp32" | "int8" = "int8",
  decoderQuant: "fp32" | "int8" = "int8",
  preprocessor: "nemo128" | "nemo80" = "nemo128",
  onProgress?: (file: string, loaded: number, total: number) => void
): Promise<{ urls: ModelFiles; port: number }> {
  await ensureDirectory();

  // Start model server first to get the port
  const port = await startModelServer();

  const files = getModelFiles(encoderQuant, decoderQuant, preprocessor);

  logDebug(`📥 Downloading ${files.length} model files...`);

  for (const file of files) {
    const exists = await fileExists(file.localPath);

    if (exists) {
      const stats = await stat(file.localPath);
      logDebug(`✅ ${file.filename} already exists (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
      onProgress?.(file.filename, stats.size, stats.size);
    } else {
      logDebug(`📥 Downloading ${file.filename}...`);
      try {
        await downloadFile(file.url, file.localPath, (loaded, total) => {
          onProgress?.(file.filename, loaded, total);
        });
        const stats = await stat(file.localPath);
        logDebug(`✅ Downloaded ${file.filename} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
      } catch (error) {
        // .data files are optional
        if (file.filename.endsWith(".data")) {
          logDebug(`⚠️ Optional file ${file.filename} not found, continuing...`);
          continue;
        }
        throw error;
      }
    }
  }

  // Return URLs - served via local HTTP server
  const encoderName = `encoder-model${encoderQuant === "int8" ? ".int8.onnx" : ".onnx"}`;
  const decoderName = `decoder_joint-model${decoderQuant === "int8" ? ".int8.onnx" : ".onnx"}`;

  return {
    urls: {
      encoderUrl: `http://127.0.0.1:${port}/models/${encoderName}`,
      decoderUrl: `http://127.0.0.1:${port}/models/${decoderName}`,
      encoderDataUrl: (await fileExists(join(PARAKET_MODELS_DIR, `${encoderName}.data`)))
        ? `http://127.0.0.1:${port}/models/${encoderName}.data`
        : null,
      decoderDataUrl: (await fileExists(join(PARAKET_MODELS_DIR, `${decoderName}.data`)))
        ? `http://127.0.0.1:${port}/models/${decoderName}.data`
        : null,
      tokenizerUrl: `http://127.0.0.1:${port}/models/vocab.txt`,
      preprocessorUrl: `http://127.0.0.1:${port}/models/${preprocessor}.onnx`,
    },
    port,
  };
}

/**
 * Start local HTTP server to serve model files
 */
let modelServer: ReturnType<typeof createServer> | null = null;
let serverPort = 4097;

export async function startModelServer(): Promise<number> {
  if (modelServer) {
    return serverPort;
  }

  const { createServer } = await import("http");
  const { readFile } = await import("fs/promises");
  const { lookup } = await import("mime-types");

  modelServer = createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(400);
      res.end();
      return;
    }

    // Serve files from models directory
    if (req.url.startsWith("/models/")) {
      const filename = req.url.replace("/models/", "");
      const filePath = join(PARAKET_MODELS_DIR, filename);

      try {
        if (await fileExists(filePath)) {
          const { createReadStream } = await import("fs");
          const { stat } = await import("fs/promises");
          const fileStats = await stat(filePath);
          const mimeType = lookup(filePath) || "application/octet-stream";

          res.writeHead(200, {
            "Content-Type": mimeType,
            "Content-Length": fileStats.size,
            "Access-Control-Allow-Origin": "*",
          });

          const readStream = createReadStream(filePath);
          readStream.pipe(res);
        } else {
          res.writeHead(404);
          res.end("File not found");
        }
      } catch (error) {
        logError("Error serving model file:", error);
        res.writeHead(500);
        res.end("Internal server error");
      }
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  return new Promise((resolve, reject) => {
    modelServer!.listen(serverPort, "127.0.0.1", () => {
      logDebug(`✅ Model file server started on http://127.0.0.1:${serverPort}`);
      resolve(serverPort);
    });

    modelServer!.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        // Port in use, try next port
        serverPort++;
        modelServer!.listen(serverPort, "127.0.0.1", () => {
          logDebug(`✅ Model file server started on http://127.0.0.1:${serverPort}`);
          resolve(serverPort);
        });
      } else {
        reject(error);
      }
    });
  });
}

/**
 * Stop model server
 */
export function stopModelServer(): void {
  if (modelServer) {
    modelServer.close();
    modelServer = null;
    logDebug("🛑 Model file server stopped");
  }
}

/**
 * Get model file paths (for direct file access if needed)
 */
export function getModelFilePaths(encoderQuant: "fp32" | "int8" = "int8", decoderQuant: "fp32" | "int8" = "int8", preprocessor: "nemo128" | "nemo80" = "nemo128"): {
  encoder: string;
  decoder: string;
  encoderData: string | null;
  decoderData: string | null;
  tokenizer: string;
  preprocessor: string;
} {
  const encoderName = `encoder-model${encoderQuant === "int8" ? ".int8.onnx" : ".onnx"}`;
  const decoderName = `decoder_joint-model${decoderQuant === "int8" ? ".int8.onnx" : ".onnx"}`;

  return {
    encoder: join(PARAKET_MODELS_DIR, encoderName),
    decoder: join(PARAKET_MODELS_DIR, decoderName),
    encoderData: join(PARAKET_MODELS_DIR, `${encoderName}.data`),
    decoderData: join(PARAKET_MODELS_DIR, `${decoderName}.data`),
    tokenizer: join(PARAKET_MODELS_DIR, "vocab.txt"),
    preprocessor: join(PARAKET_MODELS_DIR, `${preprocessor}.onnx`),
  };
}

