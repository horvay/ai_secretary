import { describe, expect, test } from "bun:test";
import { ARI_DECIDES_CONFIDENCE_THRESHOLD, buildAriVoiceDecisionPrompt, parseAriVoiceDecision } from "./voiceDecision";
import { shouldDropAsVoiceNoise } from "../../avatar/services/inputFilter";

describe("ari-decides JSON-only voice decision", () => {
  test("responds when confidence is at the threshold and speech exists", () => {
    const parsed = parseAriVoiceDecision('{"decision":"respond","confidence":0.7,"reason":"direct","speech":"Yes boss."}');
    expect(parsed.shouldRespond).toBe(true);
    expect(parsed.raw.speech).toBe("Yes boss.");
  });

  test("responds when confidence is above threshold", () => {
    const parsed = parseAriVoiceDecision('{"decision":"respond","confidence":0.91,"reason":"asked Ari","speech":"On it."}');
    expect(parsed.shouldRespond).toBe(true);
    expect(parsed.raw.confidence).toBe(0.91);
  });

  test("low-confidence respond must have empty speech and does not respond", () => {
    const parsed = parseAriVoiceDecision('{"decision":"respond","confidence":0.69,"reason":"uncertain","speech":""}');
    expect(parsed.shouldRespond).toBe(false);
  });

  test("low-confidence speech is invalid", () => {
    expect(() => parseAriVoiceDecision('{"decision":"respond","confidence":0.69,"reason":"uncertain","speech":"Maybe."}')).toThrow();
  });

  test("no_response requires empty speech", () => {
    const parsed = parseAriVoiceDecision('{"decision":"no_response","confidence":0.99,"reason":"background","speech":""}');
    expect(parsed.shouldRespond).toBe(false);
    expect(parsed.raw.speech).toBe("");
  });

  test("no_response with speech is invalid", () => {
    expect(() => parseAriVoiceDecision('{"decision":"no_response","confidence":0.99,"reason":"background","speech":"Nope."}')).toThrow();
  });

  test("legacy marker fallback is rejected", () => {
    expect(() => parseAriVoiceDecision("[NO_RESPONSE] background chatter")).toThrow();
  });

  test("markdown fenced JSON is rejected", () => {
    expect(() => parseAriVoiceDecision('```json\n{"decision":"respond","confidence":0.8,"reason":"followup","speech":"Sure."}\n```')).toThrow();
  });

  test("malformed JSON throws", () => {
    expect(() => parseAriVoiceDecision('{"decision":"respond",')).toThrow();
  });

  test("prompt contains threshold, speech attribute, and JSON-only contract", () => {
    const prompt = buildAriVoiceDecisionPrompt({
      userSpeech: "what is that",
      secretaryStatus: "normal",
      timestampedSpeech: "[1:23 PM] what is that",
    });
    expect(prompt).toContain("[VoiceMode: ari-decides-json-only]");
    expect(prompt).toContain(String(ARI_DECIDES_CONFIDENCE_THRESHOLD));
    expect(prompt).toContain("Return ONLY a raw JSON object");
    expect(prompt).toContain("speech");
  });
});

describe("voice input hygiene before JSON AI routing", () => {
  test("drops filler noise", () => {
    expect(shouldDropAsVoiceNoise("um")).toBe(true);
    expect(shouldDropAsVoiceNoise("hmm")).toBe(true);
  });

  test("drops short acknowledgements outside followup", () => {
    expect(shouldDropAsVoiceNoise("yes")).toBe(true);
    expect(shouldDropAsVoiceNoise("ok")).toBe(true);
  });

  test("keeps short acknowledgements in followup", () => {
    expect(shouldDropAsVoiceNoise("yes", { isFollowupMode: true })).toBe(false);
    expect(shouldDropAsVoiceNoise("ok", { isFollowupMode: true })).toBe(false);
  });

  test("drops meaningless one-letter speech even in followup", () => {
    expect(shouldDropAsVoiceNoise("a", { isFollowupMode: true })).toBe(true);
  });

  test("keeps meaningful speech without wake word", () => {
    expect(shouldDropAsVoiceNoise("what time is the meeting")).toBe(false);
    expect(shouldDropAsVoiceNoise("can you pass me that file")).toBe(false);
  });
});
