export const ARI_DECIDES_CONFIDENCE_THRESHOLD = 0.7;

export type AriVoiceDecisionValue = "respond" | "no_response";

export interface AriVoiceDecision {
  decision: AriVoiceDecisionValue;
  confidence: number;
  reason: string;
  speech: string;
}

export interface ParsedAriVoiceDecision {
  raw: AriVoiceDecision;
  shouldRespond: boolean;
  reason: string;
}

function normalizeDecision(value: unknown): AriVoiceDecisionValue | null {
  if (value === "respond" || value === "no_response") return value;
  return null;
}

export function parseAriVoiceDecision(text: string): ParsedAriVoiceDecision {
  const trimmed = text.trim();
  const parsed = JSON.parse(trimmed) as unknown;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Ari voice decision must be a JSON object");
  }

  const record = parsed as Record<string, unknown>;
  const decision = normalizeDecision(record.decision);
  const confidence = typeof record.confidence === "number" ? record.confidence : Number(record.confidence);
  const reason = typeof record.reason === "string" ? record.reason : "";
  const speech = typeof record.speech === "string" ? record.speech : "";

  if (!decision) throw new Error("Ari voice decision must use decision respond or no_response");
  if (!Number.isFinite(confidence)) throw new Error("Ari voice decision confidence must be numeric");

  const normalizedConfidence = Math.max(0, Math.min(1, confidence));
  const shouldRespond = decision === "respond" && normalizedConfidence >= ARI_DECIDES_CONFIDENCE_THRESHOLD;

  if (shouldRespond && speech.trim().length === 0) {
    throw new Error("Ari voice decision respond requires non-empty speech");
  }
  if (!shouldRespond && speech.trim().length > 0) {
    throw new Error("Ari voice decision no_response/low-confidence must have empty speech");
  }

  const raw: AriVoiceDecision = {
    decision,
    confidence: normalizedConfidence,
    reason,
    speech,
  };

  const thresholdReason = shouldRespond
    ? reason || `respond confidence ${normalizedConfidence} >= ${ARI_DECIDES_CONFIDENCE_THRESHOLD}`
    : decision === "respond"
      ? `respond confidence ${normalizedConfidence} below ${ARI_DECIDES_CONFIDENCE_THRESHOLD}`
      : reason || "decision was no_response";

  return { raw, shouldRespond, reason: thresholdReason };
}

export function buildAriVoiceDecisionPrompt(params: {
  userSpeech: string;
  secretaryStatus: string;
  timestampedSpeech: string;
  isFollowup?: boolean;
}): string {
  return [
    `[SecretaryStatus: ${params.secretaryStatus}]`,
    `[VoiceMode: ari-decides-json-only]`,
    "You are Ari's voice router and final voice responder for one transcribed user utterance.",
    "You must decide whether Ari should answer, and if yes, put exactly what Ari should say in speech.",
    "Return ONLY a raw JSON object. No markdown. No code fence. No extra text. No tool calls.",
    "Required JSON shape:",
    '{"decision":"respond","confidence":0.0,"reason":"short reason","speech":"what Ari says aloud"}',
    "or",
    '{"decision":"no_response","confidence":0.0,"reason":"short reason","speech":""}',
    `Use decision "respond" only when confidence is at least ${ARI_DECIDES_CONFIDENCE_THRESHOLD} that the user is addressing Ari, continuing the current conversation, answering Ari, correcting Ari, or issuing a stop/safety command.`,
    `If confidence is below ${ARI_DECIDES_CONFIDENCE_THRESHOLD}, use decision "no_response" and speech must be empty.`,
    "The app will speak and display only the speech attribute. The app will not parse legacy markers.",
    params.isFollowup ? "Context: Ari recently spoke, so short replies like yes/no/okay may be meaningful." : "Context: Ari is not necessarily being addressed.",
    "[User speech]",
    params.timestampedSpeech,
  ].join("\n");
}
