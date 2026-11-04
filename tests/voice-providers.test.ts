import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { voiceProviders, toPcm } = await import("@/lib/voice/speech");

describe("voiceProviders", () => {
  it("listens with Groq's free Whisper first, then OpenAI, then Google", () => {
    expect(voiceProviders(["google", "groq", "openai", "anthropic"]).listen).toEqual(["groq", "openai", "google"]);
    expect(voiceProviders(["google"]).listen).toEqual(["google"]);
  });
  it("speaks with Gemini, then OpenAI; Groq and Claude have no voice here", () => {
    expect(voiceProviders(["groq", "openai", "google"]).speak).toEqual(["google", "openai"]);
    expect(voiceProviders(["groq", "anthropic"]).speak).toEqual([]);
  });
});

describe("toPcm", () => {
  it("reads the sample rate from a raw PCM type, or unwraps WAV", () => {
    expect(toPcm(new Uint8Array(10), "audio/L16;codec=pcm;rate=24000").rate).toBe(24_000);
    const wav = new Uint8Array(48);
    wav.set([82, 73, 70, 70], 0);
    new DataView(wav.buffer).setUint32(24, 16_000, true);
    wav.set([100, 97, 116, 97], 36);
    new DataView(wav.buffer).setUint32(40, 4, true);
    const out = toPcm(wav, "audio/wav");
    expect(out.rate).toBe(16_000);
    expect(out.pcm.length).toBe(4);
  });
});

const { liveSeconds, liveConfig, requestLanguages, VOICE } = await import("@/lib/voice/speech");

describe("live listening", () => {
  it("charges what the browser reports, never more than the pass allowed and never nothing", () => {
    expect(liveSeconds(12.2)).toBe(13);
    expect(liveSeconds(0)).toBe(1);
    expect(liveSeconds(-50)).toBe(1);
    expect(liveSeconds(99_999)).toBe(VOICE.live.maxSeconds);
    // A missing or made-up number counts as the whole pass.
    expect(liveSeconds("lots")).toBe(VOICE.live.maxSeconds);
    expect(liveSeconds(Number.NaN)).toBe(VOICE.live.maxSeconds);
  });
  it("passes the person's languages as hints, and asks only for text back", () => {
    expect(liveConfig(["en", "ur"])).toEqual({ responseModalities: ["TEXT"], inputAudioTranscription: { languageCodes: ["en", "ur"] } });
    expect(liveConfig([])).toEqual({ responseModalities: ["TEXT"], inputAudioTranscription: {} });
  });
  it("reads languages from the request, main one first, at most four", () => {
    const req = new Request("http://x", { headers: { "x-languages": "en-GB, ur ,en-US,hi,ar,fr,<script>" } });
    expect(requestLanguages(req)).toEqual(["en", "ur", "hi", "ar"]);
    expect(requestLanguages(new Request("http://x", { headers: { "x-language": "de-DE" } }))).toEqual(["de"]);
  });
});
