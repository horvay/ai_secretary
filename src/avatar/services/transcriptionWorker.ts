import { ParakeetModel } from "parakeet.js";

type InitMessage = {
  id: number;
  type: "init";
  urls: Record<string, string | null>;
  filenames: Record<string, string>;
  cpuThreads: number;
};

type TranscribeMessage = {
  id: number;
  type: "transcribe";
  audioBuffer: Float32Array;
};

type WorkerMessage = InitMessage | TranscribeMessage | { id: number; type: "reset" };

type WorkerResponse =
  | { id: number; type: "ready" }
  | { id: number; type: "result"; text: string }
  | { id: number; type: "reset" }
  | { id: number; type: "error"; error: string };

let model: ParakeetModel | null = null;

function respond(message: WorkerResponse) {
  self.postMessage(message);
}

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;

  try {
    if (message.type === "init") {
      model = await ParakeetModel.fromUrls({
        ...message.urls,
        filenames: message.filenames,
        backend: "wasm",
        verbose: false,
        cpuThreads: message.cpuThreads,
      });
      respond({ id: message.id, type: "ready" });
      return;
    }

    if (message.type === "reset") {
      model = null;
      respond({ id: message.id, type: "reset" });
      return;
    }

    if (message.type === "transcribe") {
      if (!model) throw new Error("Transcription worker model is not initialized.");

      const result = await model.transcribe(message.audioBuffer, 16000, {
        returnTimestamps: false,
        returnConfidences: false,
        frameStride: 2,
      });
      respond({ id: message.id, type: "result", text: (result.utterance_text || "").trim() });
    }
  } catch (error) {
    respond({ id: message.id, type: "error", error: error instanceof Error ? error.message : String(error) });
  }
};
