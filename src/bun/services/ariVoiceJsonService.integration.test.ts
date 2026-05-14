import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentClientInstance } from "./agent/types";
import { runAriVoiceJsonTurn, type AriVoiceJsonTurnResult } from "./ariVoiceJsonService";
import { createLocalLlamaAgentClient } from "./localLlamaAgentClient";

let client: AgentClientInstance;

function stamped(text: string) {
  return `[12:00 PM] ${text}`;
}

async function voice(userSpeech: string): Promise<AriVoiceJsonTurnResult> {
  const result = await runAriVoiceJsonTurn(client, {
    userSpeech,
    secretaryStatus: "normal",
    timestampedSpeech: stamped(userSpeech),
  });
  console.log("\n[local-voice-test] user:", userSpeech);
  console.log("[local-voice-test] raw:", result.rawResponse);
  console.log("[local-voice-test] parsed:", JSON.stringify(result.raw));
  expect(result.rawResponse).not.toContain("tool_calls");
  expect(result.rawResponse).not.toContain("function_call");
  return result;
}

function expectRespond(result: AriVoiceJsonTurnResult) {
  expect(result.raw.decision).toBe("respond");
  expect(result.raw.confidence).toBeGreaterThanOrEqual(0.7);
  expect(result.shouldRespond).toBe(true);
  expect(result.raw.speech.trim().length).toBeGreaterThan(0);
}

function expectNoResponse(result: AriVoiceJsonTurnResult) {
  expect(result.raw.decision).toBe("no_response");
  expect(result.shouldRespond).toBe(false);
  expect(result.raw.speech).toBe("");
}

describe("Ari JSON voice AI service with local llama.cpp model", () => {
  beforeAll(async () => {
    client = createLocalLlamaAgentClient({ reasoning: "off" });
    await client.startServer();
    await client.clearSession();
  }, 180_000);

  afterAll(async () => {
    await client?.stopServer?.();
  }, 60_000);

  test("multi-turn local voice routing uses only JSON and carries conversation context", async () => {
    const backgroundOne = await voice("Bob, the printer in accounting is out of paper.");
    expectNoResponse(backgroundOne);

    const alpha = await voice("Ari, say exactly these words: voice json alpha.");
    expectRespond(alpha);
    expect(alpha.raw.speech.toLowerCase()).toContain("voice json alpha");

    const backgroundTwo = await voice("Sarah, please move the meeting from five to six.");
    expectNoResponse(backgroundTwo);

    const remember = await voice("Ari, remember the test passphrase blue comet for this test, then say remembered blue comet.");
    expectRespond(remember);
    expect(remember.raw.speech.toLowerCase()).toContain("blue comet");

    const recall = await voice("Ari, what test passphrase did I just ask you to remember? Answer with only the passphrase.");
    expectRespond(recall);
    expect(recall.raw.speech.toLowerCase()).toContain("blue comet");

    const math = await voice("Ari, answer yes or no only: is two plus two equal to four?");
    expectRespond(math);
    expect(math.raw.speech.toLowerCase()).toContain("yes");

    const repeat = await voice("Ari, repeat exactly these three words: cats chase lasers.");
    expectRespond(repeat);
    expect(repeat.raw.speech.toLowerCase()).toContain("cats chase lasers");

    const finalBackground = await voice("This note is for Jordan, not Ari: bring the HDMI cable.");
    expectNoResponse(finalBackground);
  }, 300_000);
});
