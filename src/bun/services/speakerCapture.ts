import { spawn, type Subprocess } from "bun";
import { logInfo, logWarn } from "../utils/logger";

interface SpeakerCaptureDeps {
  sendSegment: (payload: { base64: string; sampleRate: number; startedAt: number; endedAt: number; durationMs: number; captureBackend: string; deviceName?: string }) => void;
}

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 4;
const FRAME_SAMPLES = 1024;
const SPEECH_THRESHOLD = 0.003;
const SILENCE_DURATION_MS = 1500;
const MIN_SEGMENT_MS = 300;
const MAX_SEGMENT_MS = 60000;

let proc: Subprocess | null = null;
let enabled = false;
let depsRef: SpeakerCaptureDeps | null = null;
let suppressedUntil = 0;
let lastSuppressionLogAt = 0;

function rms(samples: Float32Array) {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function concat(chunks: Float32Array[]) {
  const length = chunks.reduce((n, chunk) => n + chunk.length, 0);
  const out = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function toBase64(samples: Float32Array) {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64");
}

async function findPulseMonitor() {
  try {
    const result = spawn(["pactl", "get-default-sink"], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(result.stdout).text();
    const sink = text.trim();
    if (sink) return `${sink}.monitor`;
  } catch {
    // fall through
  }
  return "default";
}

async function startReader(captureProc: Subprocess, captureBackend: string, deviceName?: string) {
  if (!captureProc.stdout) return;
  const reader = captureProc.stdout.getReader();
  let byteBuffer = new Uint8Array(0);
  let chunks: Float32Array[] = [];
  let segmentStartedAt = 0;
  let lastVoiceAt = 0;
  let recording = false;

  const flush = (endedAt: number) => {
    if (!recording || chunks.length === 0 || !depsRef) return;
    const durationMs = endedAt - segmentStartedAt;
    const samples = concat(chunks);
    chunks = [];
    recording = false;
    segmentStartedAt = 0;
    lastVoiceAt = 0;
    if (durationMs < MIN_SEGMENT_MS || samples.length < SAMPLE_RATE * 0.1) return;
    depsRef.sendSegment({
      base64: toBase64(samples),
      sampleRate: SAMPLE_RATE,
      startedAt: endedAt - durationMs,
      endedAt,
      durationMs,
      captureBackend,
      deviceName,
    });
  };

  while (enabled && captureProc === proc) {
    const { value, done } = await reader.read();
    if (done || !value) break;
    const merged = new Uint8Array(byteBuffer.length + value.length);
    merged.set(byteBuffer);
    merged.set(value, byteBuffer.length);
    byteBuffer = merged;

    const frameBytes = FRAME_SAMPLES * BYTES_PER_SAMPLE * CHANNELS;
    while (byteBuffer.length >= frameBytes) {
      const frame = byteBuffer.slice(0, frameBytes);
      byteBuffer = byteBuffer.slice(frameBytes);
      const samples = new Float32Array(frame.buffer, frame.byteOffset, FRAME_SAMPLES);
      const now = Date.now();
      if (now < suppressedUntil) {
        if (recording || chunks.length > 0) {
          chunks = [];
          recording = false;
          segmentStartedAt = 0;
          lastVoiceAt = 0;
        }
        if (now - lastSuppressionLogAt > 2000) {
          lastSuppressionLogAt = now;
          logInfo("[SpeakerCapture] Suppressing speaker capture while Ari TTS is playing");
        }
        continue;
      }
      const level = rms(samples);
      if (level >= SPEECH_THRESHOLD) {
        if (!recording) {
          recording = true;
          segmentStartedAt = now;
          chunks = [];
        }
        lastVoiceAt = now;
      }
      if (recording) {
        chunks.push(new Float32Array(samples));
        if (now - segmentStartedAt >= MAX_SEGMENT_MS || (lastVoiceAt > 0 && now - lastVoiceAt >= SILENCE_DURATION_MS)) {
          flush(now);
        }
      }
    }
  }
  flush(Date.now());
}

export async function startSpeakerCapture(deps: SpeakerCaptureDeps) {
  depsRef = deps;
  if (enabled) return;
  if (process.platform !== "linux") {
    logWarn("[SpeakerCapture] Speaker transcription is currently implemented for Linux only");
    return;
  }

  enabled = true;
  const monitor = await findPulseMonitor();
  const commands = [
    { args: ["parec", `--device=${monitor}`, "--format=float32le", `--rate=${SAMPLE_RATE}`, `--channels=${CHANNELS}`], backend: "parec", deviceName: monitor },
    { args: ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "pulse", "-i", monitor, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1"], backend: "ffmpeg-pulse", deviceName: monitor },
  ];

  for (const command of commands) {
    try {
      proc = spawn(command.args, { stdout: "pipe", stderr: "pipe" });
      logInfo(`[SpeakerCapture] Started ${command.backend} on ${monitor}`);
      void startReader(proc, command.backend, command.deviceName).catch((error) => logWarn("[SpeakerCapture] Reader failed:", error));
      return;
    } catch (error) {
      logWarn(`[SpeakerCapture] Failed to start ${command.backend}:`, error);
    }
  }
  enabled = false;
}

export function stopSpeakerCapture() {
  enabled = false;
  if (proc) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
  proc = null;
  logInfo("[SpeakerCapture] Stopped");
}

export function suppressSpeakerCaptureForAriTts(durationMs: number = 1500) {
  suppressedUntil = Math.max(suppressedUntil, Date.now() + Math.max(0, durationMs));
}

export function clearSpeakerCaptureSuppression(afterMs: number = 1200) {
  suppressedUntil = Math.max(suppressedUntil, Date.now() + Math.max(0, afterMs));
}

export function isSpeakerCaptureRunning() {
  return enabled && proc !== null;
}
