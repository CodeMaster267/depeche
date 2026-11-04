import "server-only";
import OpenAI, { toFile } from "openai";
import { GoogleGenAI, Modality, ThinkingLevel } from "@google/genai";
import { fakeAi } from "@/lib/ai/providers";
import type { Provider } from "@/lib/ai/models";
import { providerFileName } from "@/lib/voice/notes";

/**
 * Speech in and out, on the family's own keys.
 *
 * Listening (speech to text) needs a provider that understands audio: Gemini Flash-Lite first (it
 * works on free Google keys, so it usually costs nothing), then OpenAI's transcription model. Anthropic
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
    openai: { model: "gpt-transcribe", perMinute: 0.0045 },
    // Audio input is estimated at 32 tokens a second at twice Flash's text price, to err high.
    // Flash-Lite first: writing out speech needs no deep model, and it answers in a second or two.
    google: { model: "gemini-3.5-flash-lite", fallback: "gemini-3.8-flash", perMillionIn: 3, perMillionOut: 7.5 },
  },
  speak: {
    // Voice chat asks for the faster Flash-Lite voice first; "Read aloud" uses Flash. Flash-Lite is
    // priced as Flash here, to err high.
    google: { model: "gemini-3.8-flash-tts", fast: "gemini-3.8-flash-lite-tts", voice: "Kore", perMillionIn: 1, perMillionAudio: 18, audioTokensPerSecond: 25 },
    // Leaves the API on 6 Jan 2027; the browser voice takes over if it stops working.
    openai: { model: "gpt-4o-mini-tts", voice: "marin", perMinute: 0.015 },
  },
  /**
   * Live listening for voice chat: the browser streams the microphone straight to Google's live
   * transcription model with a one-time pass from the server, and words appear as they're said.
   * $0.54 an audio hour on paid keys (free tier on free keys).
   */
  live: { model: "gemini-3.5-transcribe-live", perMinute: 0.54 / 60, maxSeconds: 240 },
} as const;

/**
 * A one-time pass for one live listening session, made with the family's Google key, which never
 * leaves the server. It is locked to the transcription model and these settings, must be used
 * within a minute, and stops working after `VOICE.live.maxSeconds`.
 */
export async function liveToken(apiKey: string, languages: string[]): Promise<{ token: string; model: string; expiresAt: string }> {
  const { model, maxSeconds } = VOICE.live;
  const now = Date.now();
  const expiresAt = new Date(now + maxSeconds * 1000).toISOString();
  if (fakeAi()) return { token: "fake", model, expiresAt };
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1alpha" } });
  const token = await ai.authTokens.create({
    config: {
      uses: 1,
      expireTime: expiresAt,
      newSessionExpireTime: new Date(now + 60_000).toISOString(),
      liveConnectConstraints: { model, config: liveConfig(languages) },
      lockAdditionalFields: [],
    },
  });
  if (!token.name) throw new Error("Google didn't hand out a live pass.");
  return { token: token.name, model, expiresAt };
}

/** The live session's settings; the browser connects with exactly these. */
export function liveConfig(languages: string[]) {
  return {
    responseModalities: [Modality.TEXT],
    inputAudioTranscription: { ...(languages.length ? { languageCodes: languages } : {}) },
  };
}

/** The languages the person speaks, main one first, as a hint ("en-GB,ur" becomes ["en", "ur"]). */
export function requestLanguages(req: Request): string[] {
  return [
    ...new Set(
      (req.headers.get("x-languages") ?? req.headers.get("x-language") ?? "")
        .split(",")
        .map((l) => l.trim().slice(0, 2).toLowerCase())
        .filter((l) => /^[a-z]{2}$/.test(l)),
    ),
  ].slice(0, 4);
}

/** Seconds of live listening to charge: what the browser reports, kept within what the pass allowed. */
export function liveSeconds(reported: unknown): number {
  const n = typeof reported === "number" && Number.isFinite(reported) ? reported : VOICE.live.maxSeconds;
  return Math.min(VOICE.live.maxSeconds, Math.max(1, Math.ceil(n)));
}

/**
 * Which providers can listen and speak, best first, given the providers a family has keys for.
 * Both prefer Gemini, which is free on free Google keys. If one fails (a used-up free quota, say),
 * the next is tried.
 */
export function voiceProviders(providers: readonly string[]): { listen: Provider[]; speak: Provider[] } {
  const has = (p: Provider) => providers.includes(p);
  return {
    listen: (["google", "openai"] as const).filter(has),
    speak: (["google", "openai"] as const).filter(has),
  };
}

/** The longest recording accepted: two minutes of 16 kHz mono 16-bit WAV is about 3.8 MB. */
export const MAX_AUDIO_BYTES = 4_000_000;
export const MAX_SPEAK_CHARS = 4_000;

export type Transcript = { text: string; model: string; cost: number; input: number; output: number };

/**
 * A recording in any format the providers take (a voice note, say), with its length in seconds.
 * Dictation sends plain WAV bytes instead.
 */
export type Recording = { bytes: Uint8Array; mime: string; seconds: number };

/** Above this, Gemini is sent the recording through its file store: a request can't pass 20 MB. */
const GOOGLE_INLINE_BYTES = 12 * 1024 * 1024;

/** Seconds of audio in a 16-bit mono WAV file, read from its header. */
export function wavSeconds(wav: Uint8Array): number {
  if (wav.length < 44) return 0;
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const rate = view.getUint32(24, true) || 16_000;
  const channels = view.getUint16(22, true) || 1;
  const bits = view.getUint16(34, true) || 16;
  return (wav.length - 44) / (rate * channels * (bits / 8));
}

/** English names for language codes ("ur" → "Urdu"). */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * A short line telling the transcriber which languages to expect. People often mix two in one
 * sentence (English and Urdu, say), so the language is suggested rather than forced: forcing one
 * would translate or garble the other.
 */
export function languageHint(languages: string[]): string {
  const names = languages.map(languageName);
  if (!names.length) return "";
  if (names.length === 1) return `This is a conversation in ${names[0]}.`;
  return `This is a conversation in ${names.slice(0, -1).join(", ")} and ${names.at(-1)}, sometimes mixing them in one sentence.`;
}

/**
 * `languages` are the languages the person speaks (two-letter codes, like "en" and "ur"), from the
 * voice settings. Without them, a model guesses from the sound alone and, on a short or noisy clip,
 * can pick a language nobody spoke.
 */
export async function transcribe(
  provider: Provider,
  apiKey: string,
  audio: Uint8Array | Recording,
  signal: AbortSignal,
  languages: string[] = [],
): Promise<Transcript> {
  const hint = languageHint(languages);
  // A voice note can be half an hour long, so it gets more time and room than dictation.
  const note = !(audio instanceof Uint8Array);
  const wav = note ? audio.bytes : audio;
  const mime = note ? audio.mime : "audio/wav";
  const seconds = note ? audio.seconds : wavSeconds(wav);
  if (fakeAi()) {
    // Tests: a fixed sentence, so a voice turn can be followed end to end.
    return { text: "What is the quadratic formula?", model: "fake", cost: 0, input: 0, output: 0 };
  }
  if (provider === "openai") {
    const client = new OpenAI({ apiKey, maxRetries: 1 });
    const res = await client.audio.transcriptions.create(
      { file: await toFile(wav, note ? providerFileName(mime) : "speech.wav", { type: mime }), model: VOICE.transcribe.openai.model, ...(hint ? { prompt: hint } : {}) },
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
    // A big recording goes through Gemini's file store (free; Google deletes it within two days).
    let sound: { inlineData: { mimeType: string; data: string } } | { fileData: { mimeType: string; fileUri: string } };
    let stored: string | undefined;
    if (wav.length > GOOGLE_INLINE_BYTES) {
      const file = await ai.files.upload({ file: new Blob([wav as BlobPart], { type: mime }), config: { mimeType: mime, abortSignal: signal } });
      stored = file.name;
      sound = { fileData: { mimeType: mime, fileUri: file.uri! } };
    } else {
      sound = { inlineData: { mimeType: mime, data: Buffer.from(wav).toString("base64") } };
    }
    const ask = (model: string, minimal: boolean) =>
      ai.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [
              sound,
              {
                text: `Transcribe this recording exactly as spoken, with normal punctuation.${note ? " Start a new paragraph when the speaker or the topic changes." : ""} ${hint} If languages are mixed, write each part in the language and script it was spoken in; never translate. Reply with only the words said. If nobody speaks, reply with nothing.`,
              },
            ],
          },
        ],
        config: {
          abortSignal: AbortSignal.any([signal, AbortSignal.timeout(note ? 240_000 : 12_000)]),
          // Half an hour of talking is about 5,000 words.
          maxOutputTokens: note ? 16_000 : 2_000,
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
    if (stored) ai.files.delete({ name: stored }).catch(() => {});
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
export async function speak(provider: Provider, apiKey: string, text: string, signal: AbortSignal, fast = false): Promise<Speech> {
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
    const ask = (model: string) => ai.models.generateContent({
      model,
      // Only the words to say: any instruction placed here gets read out as well.
      contents: [{ role: "user", parts: [{ text }] }],
      config: {
        abortSignal: signal,
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: g.voice } } },
      },
    });
    let model: string = fast ? g.fast : g.model;
    let res;
    try {
      res = await ask(model);
    } catch (e) {
      // The faster voice may not be available on every key; the usual one is.
      if (!fast || signal.aborted) throw e;
      model = g.model;
      res = await ask(model);
    }
    const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part?.inlineData?.data) throw new Error("No audio came back.");
    const bytes = new Uint8Array(Buffer.from(part.inlineData.data, "base64"));
    const { pcm, rate } = toPcm(bytes, part.inlineData.mimeType ?? "");
    const seconds = pcm.length / 2 / rate;
    const input = res.usageMetadata?.promptTokenCount ?? Math.ceil(text.length / 4);
    const output = res.usageMetadata?.candidatesTokenCount ?? Math.ceil(seconds * g.audioTokensPerSecond);
    return { pcm, rate, model, cost: (input * g.perMillionIn + output * g.perMillionAudio) / 1_000_000, input, output };
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
