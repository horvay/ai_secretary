import type { AgentClientInstance } from "./agent/types";
import { buildAriVoiceDecisionPrompt, parseAriVoiceDecision, type ParsedAriVoiceDecision } from "../utils/voiceDecision";

export interface AriVoiceJsonTurnOptions {
  userSpeech: string;
  secretaryStatus?: string;
  timestampedSpeech: string;
  isFollowup?: boolean;
  screenshot?: string;
  signal?: AbortSignal;
}

export interface AriVoiceJsonTurnResult extends ParsedAriVoiceDecision {
  rawResponse: string;
  prompt: string;
}

export async function runAriVoiceJsonTurn(
  client: AgentClientInstance,
  options: AriVoiceJsonTurnOptions,
): Promise<AriVoiceJsonTurnResult> {
  const secretaryStatus = options.secretaryStatus?.trim() || "normal";
  const prompt = buildAriVoiceDecisionPrompt({
    userSpeech: options.userSpeech,
    secretaryStatus,
    timestampedSpeech: options.timestampedSpeech,
    isFollowup: options.isFollowup,
  });

  const response = await client.query(
    { query: prompt, context: options.screenshot ? { screenshot: options.screenshot } : undefined },
    { signal: options.signal, ephemeral: true },
  );
  const rawResponse = response.response ?? "";
  const parsed = parseAriVoiceDecision(rawResponse);

  return {
    ...parsed,
    rawResponse,
    prompt,
  };
}
