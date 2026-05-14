import { getDatabase } from "../db";
import { getSetting, setSetting } from "./app-state";
import { logDebug, logWarn } from "../utils/logger";

export type AudioTranscriptSource = "microphone" | "speaker";
export type AudioTranscriptSourceFilter = AudioTranscriptSource | "all";

export interface AudioTranscriptRecord {
  id: number;
  source: AudioTranscriptSource;
  content: string;
  started_at: number | null;
  ended_at: number | null;
  timestamp: number;
  date: number;
  app_name: string | null;
  window_title: string | null;
  session_id: string | null;
  turn_id: string | null;
  routed_to_ai: number;
  duration_ms: number | null;
  sample_rate: number | null;
  model: string | null;
  language: string | null;
  confidence: number | null;
  capture_backend: string | null;
  device_name: string | null;
  metadata: string | null;
}

export interface LogAudioTranscriptParams {
  source: AudioTranscriptSource;
  content: string;
  startedAt?: number;
  endedAt?: number;
  timestamp?: number;
  appName?: string;
  windowTitle?: string;
  sessionId?: string;
  turnId?: string;
  routedToAi?: boolean;
  durationMs?: number;
  sampleRate?: number;
  model?: string;
  language?: string;
  confidence?: number;
  captureBackend?: string;
  deviceName?: string;
  metadata?: Record<string, unknown>;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function dateIntFromMs(timestamp: number) {
  const d = new Date(timestamp);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function clampLimit(limit?: number) {
  if (!Number.isFinite(limit ?? DEFAULT_LIMIT)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT)));
}

function normalizeSource(source?: AudioTranscriptSourceFilter) {
  return source === "microphone" || source === "speaker" ? source : "all";
}

function sanitizeFtsQuery(query: string) {
  const tokens = query
    .slice(0, 240)
    .match(/[\p{L}\p{N}_'-]+/gu)
    ?.map((token) => token.replace(/"/g, "").trim())
    .filter(Boolean)
    .slice(0, 12) ?? [];
  return tokens.map((token) => `"${token}"`).join(" ");
}

function buildFilters(params: { source?: AudioTranscriptSourceFilter; startTime?: number; endTime?: number }, values: unknown[]) {
  const filters: string[] = [];
  const source = normalizeSource(params.source);
  if (source !== "all") {
    filters.push("a.source = ?");
    values.push(source);
  }
  if (typeof params.startTime === "number") {
    filters.push("a.timestamp >= ?");
    values.push(params.startTime);
  }
  if (typeof params.endTime === "number") {
    filters.push("a.timestamp <= ?");
    values.push(params.endTime);
  }
  return filters.length ? `WHERE ${filters.join(" AND ")}` : "";
}

export function logAudioTranscript(params: LogAudioTranscriptParams): number | null {
  const content = params.content.trim();
  if (!content) return null;

  const db = getDatabase();
  const timestamp = params.timestamp ?? params.endedAt ?? Date.now();
  const metadata = params.metadata ? JSON.stringify(params.metadata) : null;
  const result = db
    .query(
      `INSERT INTO audio_transcripts (
        source, content, started_at, ended_at, timestamp, date, app_name, window_title,
        session_id, turn_id, routed_to_ai, duration_ms, sample_rate, model, language,
        confidence, capture_backend, device_name, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.source,
      content,
      params.startedAt ?? null,
      params.endedAt ?? null,
      timestamp,
      dateIntFromMs(timestamp),
      params.appName ?? null,
      params.windowTitle ?? null,
      params.sessionId ?? null,
      params.turnId ?? null,
      params.routedToAi ? 1 : 0,
      params.durationMs ?? null,
      params.sampleRate ?? null,
      params.model ?? null,
      params.language ?? null,
      params.confidence ?? null,
      params.captureBackend ?? null,
      params.deviceName ?? null,
      metadata
    );

  logDebug("[AudioTranscripts] Logged transcript", params.source, result.lastInsertRowid);
  return Number(result.lastInsertRowid);
}

export function searchAudioTranscripts(params: {
  query?: string;
  source?: AudioTranscriptSourceFilter;
  startTime?: number;
  endTime?: number;
  limit?: number;
}): AudioTranscriptRecord[] {
  const db = getDatabase();
  const limit = clampLimit(params.limit);
  const query = (params.query ?? "").trim();

  if (!query) {
    return getAudioTranscriptsInRange({
      source: params.source,
      startTime: params.startTime ?? 0,
      endTime: params.endTime ?? Date.now(),
      limit,
    });
  }

  const fts = sanitizeFtsQuery(query);
  if (fts) {
    try {
      const values: unknown[] = [];
      const where = buildFilters(params, values);
      values.push(fts, limit);
      return db
        .query(
          `SELECT a.*
           FROM audio_transcripts a
           JOIN audio_transcripts_fts fts ON fts.rowid = a.id
           ${where ? `${where} AND` : "WHERE"} audio_transcripts_fts MATCH ?
           ORDER BY bm25(audio_transcripts_fts), a.timestamp DESC
           LIMIT ?`
        )
        .all(...values) as AudioTranscriptRecord[];
    } catch (error) {
      logWarn("[AudioTranscripts] FTS search failed, falling back to LIKE:", error);
    }
  }

  const values: unknown[] = [];
  const where = buildFilters(params, values);
  values.push(`%${query.slice(0, 240)}%`, limit);
  return db
    .query(
      `SELECT a.* FROM audio_transcripts a
       ${where ? `${where} AND` : "WHERE"} a.content LIKE ?
       ORDER BY a.timestamp DESC
       LIMIT ?`
    )
    .all(...values) as AudioTranscriptRecord[];
}

export function getRecentAudioTranscripts(params: {
  source?: AudioTranscriptSourceFilter;
  minutes?: number;
  limit?: number;
} = {}): AudioTranscriptRecord[] {
  const minutes = Math.max(1, Math.min(24 * 60, Math.floor(params.minutes ?? 5)));
  const now = Date.now();
  return getAudioTranscriptsInRange({
    source: params.source,
    startTime: now - minutes * 60 * 1000,
    endTime: now,
    limit: params.limit,
  });
}

export function getAudioTranscriptsInRange(params: {
  source?: AudioTranscriptSourceFilter;
  startTime: number;
  endTime: number;
  limit?: number;
}): AudioTranscriptRecord[] {
  const db = getDatabase();
  const values: unknown[] = [];
  const where = buildFilters(params, values);
  values.push(clampLimit(params.limit));
  return db
    .query(`SELECT a.* FROM audio_transcripts a ${where} ORDER BY a.timestamp DESC LIMIT ?`)
    .all(...values) as AudioTranscriptRecord[];
}

export function getMicrophoneSendToAi() {
  return getSetting("voice.microphoneSendToAi");
}

export function setMicrophoneSendToAi(enabled: boolean) {
  setSetting("voice.microphoneSendToAi", enabled);
  return getMicrophoneSendToAi();
}

export function getSpeakerTranscriptionEnabled() {
  return getSetting("audioTranscripts.speaker.enabled");
}

export function setSpeakerTranscriptionEnabled(enabled: boolean) {
  setSetting("audioTranscripts.speaker.enabled", enabled);
  return getSpeakerTranscriptionEnabled();
}
