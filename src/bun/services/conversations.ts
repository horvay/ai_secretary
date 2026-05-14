/**
 * Conversation session/turn service.
 *
 * App-level sessions and turns make conversation memory reconstructable without
 * depending solely on pi's internal session representation.
 */

import { randomUUID } from "crypto";
import { getDatabase, type ConversationSession, type ConversationTurn } from "../db";

let activeConversationSessionId: string | null = null;
let activePiSessionId: string | null = null;

export function getActiveConversationSessionId() {
  return activeConversationSessionId;
}

export function getOrCreateConversationSession(params?: {
  piSessionId?: string | null;
  title?: string;
}): ConversationSession {
  const db = getDatabase();
  const piSessionId = params?.piSessionId ?? null;

  if (activeConversationSessionId) {
    const existing = db
      .query("SELECT * FROM conversation_sessions WHERE id = ?")
      .get(activeConversationSessionId) as ConversationSession | null;
    if (existing) {
      if (!piSessionId || existing.pi_session_id === piSessionId) {
        return existing;
      }
      // A new pi session means we should start a fresh app-level conversation session,
      // not overwrite the old one.
      activeConversationSessionId = null;
      activePiSessionId = null;
    }
  }

  if (piSessionId) {
    const existing = db
      .query("SELECT * FROM conversation_sessions WHERE pi_session_id = ? ORDER BY started_at DESC LIMIT 1")
      .get(piSessionId) as ConversationSession | null;
    if (existing) {
      activeConversationSessionId = existing.id;
      activePiSessionId = piSessionId;
      return existing;
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const id = randomUUID();
  db.query(
    `INSERT INTO conversation_sessions (id, pi_session_id, title, started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, piSessionId, params?.title ?? null, now, now, now);

  activeConversationSessionId = id;
  activePiSessionId = piSessionId;
  return getConversationSession(id)!;
}

export function getConversationSession(id: string): ConversationSession | null {
  const db = getDatabase();
  return db.query("SELECT * FROM conversation_sessions WHERE id = ?").get(id) as ConversationSession | null;
}

export function startConversationTurn(params: {
  sessionId?: string;
  piSessionId?: string | null;
  source: ConversationTurn["source"];
}): ConversationTurn {
  const db = getDatabase();
  const session = params.sessionId
    ? getConversationSession(params.sessionId)
    : getOrCreateConversationSession({ piSessionId: params.piSessionId });

  if (!session) throw new Error("Unable to create conversation turn without a session");

  const now = Math.floor(Date.now() / 1000);
  const id = randomUUID();
  db.query(
    `INSERT INTO conversation_turns (id, session_id, started_at, status, source)
     VALUES (?, ?, ?, 'running', ?)`
  ).run(id, session.id, now, params.source);

  return getConversationTurn(id)!;
}

export function getConversationTurn(id: string): ConversationTurn | null {
  const db = getDatabase();
  return db.query("SELECT * FROM conversation_turns WHERE id = ?").get(id) as ConversationTurn | null;
}

export function finishConversationTurn(id: string, status: ConversationTurn["status"] = "completed"): void {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);
  db.query("UPDATE conversation_turns SET status = ?, completed_at = ? WHERE id = ?").run(status, now, id);

  const turn = getConversationTurn(id);
  if (turn) {
    db.query("UPDATE conversation_sessions SET updated_at = ? WHERE id = ?").run(now, turn.session_id);
  }
}

export function endConversationSession(sessionId: string): void {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);
  db.query("UPDATE conversation_sessions SET ended_at = ?, updated_at = ? WHERE id = ?").run(now, now, sessionId);
}

export function resetActiveConversationSession(): void {
  if (activeConversationSessionId) {
    endConversationSession(activeConversationSessionId);
  }
  activeConversationSessionId = null;
  activePiSessionId = null;
}
