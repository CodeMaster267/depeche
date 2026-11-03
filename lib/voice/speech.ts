import "server-only";
import OpenAI, { toFile } from "openai";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { fakeAi } from "@/lib/ai/providers";
import type { Provider } from "@/lib/ai/models";

/**
 * Speech in and out, on the family's own keys.
 *
 * Listening (speech to text) needs a provider that understands audio: OpenAI's transcription model
 * if the family has an OpenAI key, otherwise Gemini Flash (works on free Google keys). Anthropic
 * has no audio input, so a Claude-only family can't use the mic.
 *
 * Speaking (text to speech) prefers Gemini's speech model (also free on free keys), then OpenAI's.
 * If neither works the browser reads the reply in its own built-in voice instead, which is free.
 *
 * Prices checked 3 Nov 2026. Google's speech prices double on 1 Jan 2027; the later price is used
 * now so spending limits are never overshot.
 */
export const VOICE = {
  transcribe: {
    // Groq's Whisper: free tier on Groq keys, and fast. $0.04 an audio hour on paid keys.
    groq: { model: "whisper-large-v3-turbo", perMinute: 0.04 / 60 },
    openai: { model: "gpt-transcribe", perMinute: 0.0045 },
    // Audio input is estimated at 32 tokens a second at twice Flash's text price, to err high.
    // Flash-Lite first: writing out speech needs no deep model, and it answers in a second or two.
    google: { model: "gemini-3.5-flash-lite", fallback: "gemini-3.8-flash", perMillionIn: 3, perMillionOut: 7.5 },
  },
  speak: {
    google: { model: "gemini-3.8-flash-tts", voice: "Kore", perMillionIn: 1, perMillionAudio: 18, audioTokensPerSecond: 25 },
    // Leaves the API on 6 Jan 2027; the browser voice takes over if it stops working.
    openai: { model: "gpt-4o-mini-tts", voice: "marin", perMinute: 0.015 },
  },
} as const;

/** Which provider listens and which speaks, given the providers a family has keys for. */
/**
 * Which providers can listen and speak, best first, given the providers a family has keys for.
 * Listening prefers Groq's free Whisper. If one fails (a used-up free quota, say), the next is
 * tried. Groq's own speech voice is left out for now: it is a preview limited to 200 characters.
 */
export function voiceProviders(providers: readonly string[]): { listen: Provider[]; speak: Provider[] } {
  const has = (p: Provider) => providers.includes(p);
  return {
    listen: (["groq", "openai", "google"] as const).filter(has),
    speak: (["google", "openai"] as const).filter(has),
  };
}

/** The longest recording accepted: two minutes of 16 kHz mono 16-bit WAV is about 3.8 MB. */
export const MAX_AUDIO_BYTES = 4_000_000;
export const MAX_SPEAK_CHARS = 4_000;

export type Transcript = { text: string; model: string; cost: number; input: number; output: number };

/** Seconds of audio in a 16-bit mono WAV file, read from its header. */
export function wavSeconds(wav: Uint8Array): number {
  if (wav.length < 44) return 0;
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const rate = view.getUint32(24, true) || 16_000;
  const channels = view.getUint16(22, true) || 1;
  const bits = view.getUint16(34, true) || 16;
  return (wav.length - 44) / (rate * channels * (bits / 8));
}

export async function transcribe(provider: Provider, apiKey: string, wav: Uint8Array, signal: AbortSignal): Promise<Transcript> {
  const seconds = wavSeconds(wav);
  if (fakeAi()) {
    // Tests: a fixed sentence, so a voice turn can be followed end to end.
    return { text: "What is the quadratic formula?", model: "fake", cost: 0, input: 0, output: 0 };
  }
  if (provider === "groq") {
    // Groq speaks OpenAI's API, so the same client works with Groq's address.
    const client = new OpenAI({ apiKey, baseURL: "https://api.groq.com/openai/v1", maxRetries: 0, timeout: 15_000 });
    const g = VOICE.transcribe.groq;
    const res = await client.audio.transcriptions.create(
      { file: await toFile(wav, "speech.wav", { type: "audio/wav" }), model: g.model, response_format: "json" },
      { signal },
    );
    return {
      text: res.text.trim(),
      model: g.model,
      // Groq bills at least 10 seconds a request.
      cost: (Math.max(10, seconds) / 60) * g.perMinute,
      input: Math.ceil(seconds * 32),
      output: Math.ceil(res.text.length / 4),
    };
  }
  if (provider === "openai") {
    const client = new OpenAI({ apiKey, maxRetries: 1 });
    const res = await client.audio.transcriptions.create(
      { file: await toFile(wav, "speech.wav", { type: "audio/wav" }), model: VOICE.transcribe.openai.model },
      { signal },
    );
    return {
      text: res.text.trim(),
      model: VOICE.transcribe.openai.model,
      cost: (seconds / 60) * VOICE.transcribe.openai.perMinute,
      input: Math.ceil(seconds * 32),
      output: Math.ceil(res.text.length / 4),
    };
  }
  if (provider === "google") {
    const ai = new GoogleGenAI({ apiKey });
    const g = VOICE.transcribe.google;
    const ask = (model: string, minimal: boolean) =>
      ai.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: "audio/wav", data: Buffer.from(wav).toString("base64") } },
              {
                text: "Transcribe this recording exactly as spoken, in the language spoken, with normal punctuation. Reply with only the words said. If nobody speaks, reply with nothing.",
              },
            ],
          },
        ],
        config: {
          abortSignal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
          maxOutputTokens: 2_000,
          // No time spent thinking: this is copying words down, not reasoning.
          ...(minimal ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } } : {}),
        },
      });
    // Free keys are often "busy", and a model may not take the thinking setting: try the next.
    const attempts: [string, boolean][] = [
      [g.model, true],
      [g.model, false],
      [g.fallback, true],
    ];
    let res;
    let model: string = g.model;
    let lastError: unknown;
    const started = Date.now();
    for (const [m, minimal] of attempts) {
      try {
        res = await ask(m, minimal);
        model = m;
        break;
      } catch (e) {
        lastError = e;
        console.error("[voice] transcribe", m, minimal ? "minimal" : "default", "failed after", Date.now() - started, "ms:", (e as Error)?.message?.slice(0, 200));
        if (signal.aborted) throw e;
      }
    }
    if (!res) throw lastError;
    console.log("[voice] transcribed with", model, "in", Date.now() - started, "ms");
    const text = (res.text ?? "").trim();
    const input = res.usageMetadata?.promptTokenCount ?? Math.ceil(seconds * 32);
    const output = res.usageMetadata?.candidatesTokenCount ?? Math.ceil(text.length / 4);
    return { text, model, cost: (input * g.perMillionIn + output * g.perMillionOut) / 1_000_000, input, output };
  }
  throw new Error("This provider can't listen.");
}

export type Speech = { pcm: Uint8Array; rate: number; model: string; cost: number; input: number; output: number };

/** Spoken audio for some text, as 16-bit mono PCM. */
export async function speak(provider: Provider, apiKey: string, text: string, signal: AbortSignal): Promise<Speech> {
  if (fakeAi()) {
    // Tests: a quarter second of quiet tone per 40 characters, so playback can be followed.
    const rate = 24_000;
    const samples = Math.min(rate * 3, Math.ceil((text.length / 40) * rate * 0.25) + rate / 4);
    const pcm = new Int16Array(samples);
    for (let i = 0; i < samples; i++) pcm[i] = Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 800);
    return { pcm: new Uint8Array(pcm.buffer), rate, model: "fake", cost: 0, input: 0, output: 0 };
  }
  if (provider === "google") {
    const g = VOICE.speak.google;
    const ai = new GoogleGenAI({ apiKey });
    const res = await ai.models.generateContent({
      model: g.model,
      contents: [{ role: "user", parts: [{ text: `Read this aloud in a warm, natural voice:\n\n${text}` }] }],
      config: {
        abortSignal: signal,
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: g.voice } } },
      },
    });
    const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part?.inlineData?.data) throw new Error("No audio came back.");
    const bytes = new Uint8Array(Buffer.from(part.inlineData.data, "base64"));
    const { pcm, rate } = toPcm(bytes, part.inlineData.mimeType ?? "");
    const seconds = pcm.length / 2 / rate;
    const input = res.usageMetadata?.promptTokenCount ?? Math.ceil(text.length / 4);
    const output = res.usageMetadata?.candidatesTokenCount ?? Math.ceil(seconds * g.audioTokensPerSecond);
    return { pcm, rate, model: g.model, cost: (input * g.perMillionIn + output * g.perMillionAudio) / 1_000_000, input, output };
  }
  if (provider === "openai") {
    const o = VOICE.speak.openai;
    const client = new OpenAI({ apiKey, maxRetries: 1 });
    const res = await client.audio.speech.create(
      { model: o.model, voice: o.voice, input: text, response_format: "pcm", instructions: "Speak warmly and naturally, at a relaxed pace." },
      { signal },
    );
    const pcm = new Uint8Array(await res.arrayBuffer());
    const rate = 24_000;
    const seconds = pcm.length / 2 / rate;
    return { pcm, rate, model: o.model, cost: (seconds / 60) * o.perMinute, input: Math.ceil(text.length / 4), output: Math.ceil(seconds * 25) };
  }
  throw new Error("This provider can't speak.");
}

/** Providers return raw PCM ("audio/L16;rate=24000") or WAV; either becomes raw PCM here. */
export function toPcm(bytes: Uint8Array, mime: string): { pcm: Uint8Array; rate: number } {
  const isWav = bytes.length > 44 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF";
  if (isWav) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const rate = view.getUint32(24, true);
    // Find the "data" chunk rather than assuming a 44-byte header.
    let at = 12;
    while (at + 8 <= bytes.length) {
      const id = String.fromCharCode(...bytes.subarray(at, at + 4));
      const size = view.getUint32(at + 4, true);
      if (id === "data") return { pcm: bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size)), rate };
      at += 8 + size + (size % 2);
    }
    return { pcm: bytes.subarray(44), rate };
  }
  const rate = Number(/rate=(\d+)/i.exec(mime)?.[1] ?? 24_000);
  return { pcm: bytes, rate };
}
