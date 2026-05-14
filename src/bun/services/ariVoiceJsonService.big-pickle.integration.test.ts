import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentClientInstance } from "./agent/types";
import { getAgentClient } from "./agent-client";
import { runAriVoiceJsonTurn, type AriVoiceJsonTurnResult } from "./ariVoiceJsonService";
import type { AgentEvent } from "../state/appState";

let client: AgentClientInstance;
let events: AgentEvent[] = [];
let unsubscribe: (() => void) | undefined;

function stamped(text: string) {
  return `[12:00 PM] ${text}`;
}

async function voice(userSpeech: string): Promise<AriVoiceJsonTurnResult> {
  const before = events.length;
  const result = await runAriVoiceJsonTurn(client, {
    userSpeech,
    secretaryStatus: "normal",
    timestampedSpeech: stamped(userSpeech),
  });
  const turnEvents = events.slice(before);
  console.log("\n[big-pickle-voice-test] user:", userSpeech);
  console.log("[big-pickle-voice-test] raw:", result.rawResponse);
  console.log("[big-pickle-voice-test] parsed:", JSON.stringify(result.raw));
  console.log("[big-pickle-voice-test] events:", JSON.stringify(turnEvents));
  expect(turnEvents.some((event) => event.type === "tool_start" || event.type === "tool_end")).toBe(false);
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

describe("Ari JSON voice AI service with Big Pickle", () => {
  beforeAll(async () => {
    client = await getAgentClient();
    await client.startServer();
    await client.clearSession();
    unsubscribe = client.onAgentEvent((event) => events.push(event));
  }, 180_000);

  afterAll(async () => {
    unsubscribe?.();
    await client?.stopServer?.();
  }, 60_000);

  test("multi-turn voice routing returns shouldRespond and does not invoke tools during JSON decision pass", async () => {
    events = [];

    const backgroundOne = await voice("Bob, the printer in accounting is out of paper.");
    expectNoResponse(backgroundOne);

    const alpha = await voice("Ari, say exactly these words: big pickle voice json alpha.");
    expectRespond(alpha);
    expect(alpha.raw.speech.toLowerCase()).toContain("big pickle voice json alpha");

    const backgroundTwo = await voice("Sarah, please move the meeting from five to six.");
    expectNoResponse(backgroundTwo);

    const remember = await voice("Ari, remember the test passphrase amber nebula for this test, then say remembered amber nebula.");
    expectRespond(remember);
    expect(remember.raw.speech.toLowerCase()).toContain("amber nebula");

    const recall = await voice("Ari, what test passphrase did I just ask you to remember? Answer with only the passphrase.");
    expectRespond(recall);
    expect(recall.raw.speech.toLowerCase()).toContain("amber nebula");
  }, 300_000);

  test("normal Big Pickle agent path actually executes a tool", async () => {
    events = [];
    await client.clearSession();
    const response = await client.query({
      query: "Use the ai_secretary_mcp_playwright_list_tools tool once, then briefly say whether any tools were listed.",
    });
    const messages = await client.getSessionMessages(undefined, 10) as Array<{ info?: { role?: string }; parts?: Array<{ text?: string }> }>;
    const toolResult = messages.find((message) => message.info?.role === "toolResult");
    console.log("\n[big-pickle-tool-test] response:", response.response);
    console.log("[big-pickle-tool-test] events:", JSON.stringify(events));
    console.log("[big-pickle-tool-test] messages:", JSON.stringify(messages));

    expect(response.response.trim().length).toBeGreaterThan(0);
    expect(toolResult).toBeDefined();
    expect(toolResult?.parts?.some((part) => part.text?.includes("browser_navigate"))).toBe(true);
  }, 180_000);
});
