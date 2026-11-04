"use client";

import { voiceLanguages, within } from "@/lib/voice/client";

/**
 * Live listening for voice chat. The microphone is streamed straight from the browser to Gemini's
 * live transcription model, with a one-time pass from our server (the family's key never reaches
 * the browser). Words come back while the person is still talking, and once they stop the final
 * text arrives within a moment, instead of uploading a recording and waiting for it to be written
 * out.
 *
 * Anything going wrong (no Google key, no pass, the connection dropping) is reported as `null`
 * or `closed`, and voice chat carries on with the usual record-then-write-out listening.
 */

type Pass = { token: string; model: string; expiresAt: string; ticket: string };

export type LiveEvents = {
  /** Everything heard so far in this turn, updated as the person talks. */
  onText?: (text: string) => void;
};

export interface Listener {
  readonly closed: boolean;
  /** 16 kHz mono 16-bit PCM from the microphone. */
  send(pcm: Int16Array): void;
  /** Forget what was heard so far (sound picked up while the answer played, say). */
  reset(): void;
  /** The person has stopped: returns everything they said this turn, final. */
  finish(): Promise<string>;
  close(): void;
  events: LiveEvents;
}

/** Opens a live listening session, or returns null if live listening isn't available right now. */
export async function openLive(signal?: AbortSignal): Promise<Listener | null> {
  let pass: Pass;
  try {
    const res = await fetch("/api/voice/live", {
      method: "POST",
      headers: { "x-languages": voiceLanguages().join(",") },
      signal: within(signal, 8_000),
    });
    if (!res.ok) return null;
    pass = (await res.json()) as Pass;
  } catch {
    return null;
  }
  if (pass.token === "fake") return new FakeLive(pass.ticket);
  try {
    return await GeminiLive.connect(pass, signal);
  } catch (e) {
    console.warn("[voice] live", (e as Error)?.message);
    settle(pass.ticket, 0);
    return null;
  }
}

/** Tells the server how long a session ran, so its cost is recorded and the rest let go. */
function settle(ticket: string, seconds: number) {
  if (seconds <= 0) return;
  fetch("/api/voice/live/done", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket, seconds }),
    keepalive: true,
  }).catch(() => {});
}

function toBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

type LiveSession = {
  sendRealtimeInput: (p: { audio?: { data: string; mimeType: string }; audioStreamEnd?: boolean }) => void;
  close: () => void;
};
type ServerMessage = {
  serverContent?: {
    inputTranscription?: { text?: string; finished?: boolean };
    interimInputTranscription?: { text?: string };
    turnComplete?: boolean;
  };
  goAway?: unknown;
};

class GeminiLive implements Listener {
  events: LiveEvents = {};
  closed = false;
  private session: LiveSession | null = null;
  /** Final pieces of this turn, and the newest guess at the piece being said now. */
  private finals: string[] = [];
  private interim = "";
  private samples = 0;
  private waiting: (() => void) | null = null;

  private constructor(private ticket: string) {}

  static async connect(pass: Pass, signal?: AbortSignal): Promise<GeminiLive> {
    const live = new GeminiLive(pass.ticket);
    // Loaded only when voice chat opens, so the chat itself stays light.
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey: pass.token, httpOptions: { apiVersion: "v1alpha" } });
    let opened!: () => void;
    let failed!: (e: Error) => void;
    const ready = new Promise<void>((res, rej) => ((opened = res), (failed = rej)));
    const timer = setTimeout(() => failed(new Error("Live listening took too long to connect.")), 6_000);
    signal?.addEventListener("abort", () => failed(new Error("Cancelled")), { once: true });
    live.session = (await ai.live.connect({
      model: pass.model,
      // The pass fixes these on Google's side; they're repeated so the two always agree.
      config: {
        responseModalities: ["TEXT"] as never,
        inputAudioTranscription: voiceLanguages().length ? { languageCodes: voiceLanguages() } : {},
      },
      callbacks: {
        onopen: () => opened(),
        onmessage: (m: ServerMessage) => live.take(m),
        onerror: (e: ErrorEvent) => (console.warn("[voice] live error", e?.message), failed(new Error(e?.message || "Live listening failed."))),
        onclose: (e: CloseEvent) => {
          if (!live.closed) console.warn("[voice] live closed", e?.code, e?.reason);
          failed(new Error(e?.reason || "Live listening closed."));
          live.shut();
        },
      },
    })) as unknown as LiveSession;
    try {
      await ready;
    } catch (e) {
      live.close();
      throw e;
    } finally {
      clearTimeout(timer);
    }
    return live;
  }

  private text() {
    return [...this.finals, this.interim].map((t) => t.trim()).filter(Boolean).join(" ");
  }

  private take(m: ServerMessage) {
    const c = m.serverContent;
    if (m.goAway) console.warn("[voice] live ending soon");
    if (!c) return;
    if (c.interimInputTranscription?.text !== undefined) this.interim = c.interimInputTranscription.text ?? "";
    if (c.inputTranscription?.text !== undefined) {
      // A finished piece replaces the guess for it.
      this.finals.push(c.inputTranscription.text ?? "");
      this.interim = "";
    }
    this.events.onText?.(this.text());
    if (c.inputTranscription || c.turnComplete) {
      this.waiting?.();
      this.waiting = null;
    }
  }

  send(pcm: Int16Array) {
    if (this.closed || !this.session) return;
    this.samples += pcm.length;
    try {
      this.session.sendRealtimeInput({ audio: { data: toBase64(pcm), mimeType: "audio/pcm;rate=16000" } });
    } catch {
      this.shut();
    }
  }

  reset() {
    this.finals = [];
    this.interim = "";
  }

  async finish(): Promise<string> {
    if (this.closed || !this.session) return this.text();
    // "The person stopped": Google finishes the last piece straight away instead of waiting.
    try {
      this.session.sendRealtimeInput({ audioStreamEnd: true });
    } catch {
      return this.text();
    }
    if (this.interim || !this.finals.length) {
      await new Promise<void>((res) => {
        this.waiting = res;
        setTimeout(res, 1_500);
      });
    }
    return this.text();
  }

  private shut() {
    if (this.closed) return;
    this.closed = true;
    settle(this.ticket, this.samples / 16_000);
  }

  close() {
    const s = this.session;
    this.shut();
    this.session = null;
    try {
      s?.close();
    } catch {
      // Already closed.
    }
  }
}

/** Tests: hears the fake microphone's tone and "writes out" the same sentence as the server does. */
class FakeLive implements Listener {
  events: LiveEvents = {};
  closed = false;
  private loud = 0;
  private samples = 0;
  private static WORDS = "What is the quadratic formula?".split(" ");
  constructor(private ticket: string) {}
  private text() {
    const n = Math.min(FakeLive.WORDS.length, Math.ceil(this.loud / 4_000));
    return FakeLive.WORDS.slice(0, n).join(" ");
  }
  send(pcm: Int16Array) {
    if (this.closed) return;
    this.samples += pcm.length;
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += (pcm[i] / 0x8000) ** 2;
    if (Math.sqrt(sum / pcm.length) > 0.05) {
      const before = this.text();
      this.loud += pcm.length;
      if (this.text() !== before) this.events.onText?.(this.text());
    }
  }
  reset() {
    this.loud = 0;
  }
  async finish() {
    return this.loud ? FakeLive.WORDS.join(" ") : "";
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    settle(this.ticket, this.samples / 16_000);
  }
}
