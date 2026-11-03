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
