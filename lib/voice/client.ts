"use client";

import { speakable } from "@/lib/voice/text";

/**
 * Microphone and speaker for voice, built to work on iPhone Safari as a website:
 *
 * - One shared AudioContext, created and unlocked inside a tap (iOS plays nothing otherwise), is
 *   used both to record and to play.
 * - Audio is recorded as plain 16 kHz WAV, which every provider accepts and every browser can
 *   make, rather than MediaRecorder's formats, which differ between Safari and Chrome.
 * - The microphone is let go of before a reply is played. While a page holds the mic, iPhones and
 *   iPads treat it like a call: sound can go to the built-in speaker instead of headphones, and
 *   quieter. Safari's audio session is also switched between "play-and-record" and "playback".
 */

let shared: AudioContext | null = null;

/** A signal that aborts with `signal` or after `ms`. (AbortSignal.any is missing on older iPhones.) */
export function within(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(new DOMException("Timed out", "TimeoutError")), ms);
  signal?.addEventListener("abort", () => (clearTimeout(t), c.abort(signal.reason)), { once: true });
  return c.signal;
}

/** Call from a tap. Creates or wakes the audio engine and unlocks playback on iOS. */
export function unlockAudio(): AudioContext {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!shared || shared.state === "closed") shared = new Ctor();
  if (shared.state !== "running") shared.resume().catch(() => {});
  // A silent blip, started inside the tap, is what lets later sounds play on iOS.
  const blip = shared.createBuffer(1, 1, 22_050);
  const src = shared.createBufferSource();
  src.buffer = blip;
  src.connect(shared.destination);
  src.start(0);
  // The browser's own voice also needs a first word inside a tap on iOS.
  try {
    if ("speechSynthesis" in window && !primedVoice) {
      primedVoice = true;
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      window.speechSynthesis.speak(u);
    }
  } catch {
    // No built-in voice; provider audio still works.
  }
  return shared;
}
let primedVoice = false;

type AudioSessionType = "auto" | "playback" | "play-and-record";

/**
 * Tells Safari (16.4 and later) how the page is using sound, so it routes it like media: to the
 * headphones when they're in, mixed sensibly with other apps. Other browsers ignore it.
 */
export function setAudioSession(type: AudioSessionType) {
  try {
    const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    if (session && session.type !== type) session.type = type;
  } catch {
    // Not supported here.
  }
}

export function micSupported(): boolean {
  return typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

let openMics = 0;
const micOpen = () => openMics > 0;

export async function openMicStream(): Promise<MediaStream> {
  setAudioSession("play-and-record");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  openMics++;
  return stream;
}

export function closeMicStream(stream: MediaStream | null | undefined) {
  if (!stream || stream.getTracks().every((t) => t.readyState === "ended")) return;
  for (const t of stream.getTracks()) t.stop();
  openMics = Math.max(0, openMics - 1);
  if (!openMics) setAudioSession("playback");
}

export type MicOptions = {
  /** 0 to 1, about 20 times a second, for the level ring. */
  onLevel?: (level: number) => void;
  /** Stop by itself once the person has spoken and then gone quiet. */
  autoStop?: boolean;
  /** Called when it stops by itself (quiet after speech, nothing said for a while, or too long). */
  onAutoStop?: (heardSpeech: boolean) => void;
};

const TARGET_RATE = 16_000;
const MAX_SECONDS = 120;
const QUIET_AFTER_SPEECH_MS = 1_300;
const NOTHING_SAID_MS = 9_000;

/** A recording in progress. `stop()` returns the WAV; `cancel()` throws it away. */
export class Mic {
  private chunks: Float32Array[] = [];
  private length = 0;
  private done = false;
  private heard = false;
  private started = performance.now();
  private lastLoud = 0;
  private floor = 0.004;

  private constructor(
    private ctx: AudioContext,
    private stream: MediaStream,
    private source: MediaStreamAudioSourceNode,
    private node: ScriptProcessorNode,
    private opts: MicOptions,
    private ownStream: boolean,
  ) {
    node.onaudioprocess = (e) => this.take(e.inputBuffer.getChannelData(0));
  }

  /**
   * Starts recording. Pass a stream from `openMicStream()` to reuse it (voice chat keeps one open
   * for the whole conversation, so iPhones ask for the microphone once, not every turn); without
   * one, the microphone is opened now and let go when the recording ends.
   */
  static async open(ctx: AudioContext, opts: MicOptions = {}, shared?: MediaStream): Promise<Mic> {
    const stream = shared ?? (await openMicStream());
    if (ctx.state !== "running") await ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor is old but works the same everywhere, including older iPhones.
    const node = ctx.createScriptProcessor(4096, 1, 1);
    source.connect(node);
    // It only runs when connected to the output; it writes silence there.
    node.connect(ctx.destination);
    return new Mic(ctx, stream, source, node, opts, !shared);
  }

  get heardSpeech() {
    return this.heard;
  }

  private take(input: Float32Array) {
    if (this.done) return;
    this.chunks.push(new Float32Array(input));
    this.length += input.length;

    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);
    const now = performance.now();
    // The room's own noise level, learned as we go, so a fan or traffic isn't taken for speech.
    this.floor = rms < this.floor ? rms : this.floor * 0.995 + rms * 0.005;
    const loud = rms > Math.max(0.012, this.floor * 3);
    if (loud) {
      if (now - this.started > 150) this.heard = true;
      this.lastLoud = now;
    }
    this.opts.onLevel?.(Math.min(1, rms * 12));

    const seconds = this.length / this.ctx.sampleRate;
    if (seconds >= MAX_SECONDS) return this.autoStop();
    if (!this.opts.autoStop) return;
    if (this.heard && now - this.lastLoud > QUIET_AFTER_SPEECH_MS) this.autoStop();
    else if (!this.heard && now - this.started > NOTHING_SAID_MS) this.autoStop();
  }

  private autoStop() {
    if (this.done) return;
    const cb = this.opts.onAutoStop;
    this.release();
    cb?.(this.heard);
  }

  private release() {
    this.done = true;
    this.node.onaudioprocess = null;
    try {
      this.source.disconnect();
      this.node.disconnect();
    } catch {
      // Already disconnected.
    }
    if (this.ownStream) closeMicStream(this.stream);
  }

  /** Stops recording and returns it as a 16 kHz mono WAV file. */
  stop(): Blob {
    if (!this.done) this.release();
    return encodeWav(this.chunks, this.length, this.ctx.sampleRate);
  }

  cancel() {
    this.release();
    this.chunks = [];
  }
}

/** Joins the recorded pieces, resamples to 16 kHz and wraps them in a WAV header. */
export function encodeWav(chunks: Float32Array[], length: number, rate: number): Blob {
  const ratio = rate / TARGET_RATE;
  const out = Math.floor(length / ratio);
  const pcm = new Int16Array(out);
  // Averaging the samples that fall in each output step also filters out high hiss.
  let ci = 0;
  let co = 0;
  let pos = 0;
  const next = () => {
    while (ci < chunks.length && co >= chunks[ci].length) {
      ci++;
      co = 0;
    }
    if (ci >= chunks.length) return 0;
    pos++;
    return chunks[ci][co++];
  };
  for (let i = 0; i < out; i++) {
    const end = Math.floor((i + 1) * ratio);
    let sum = 0;
    let n = 0;
    while (pos < end) {
      sum += next();
      n++;
    }
    const v = Math.max(-1, Math.min(1, n ? sum / n : 0));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const header = new ArrayBuffer(44);
  const h = new DataView(header);
  const text = (at: number, s: string) => [...s].forEach((c, i) => h.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  h.setUint32(4, 36 + pcm.byteLength, true);
  text(8, "WAVE");
  text(12, "fmt ");
  h.setUint32(16, 16, true);
  h.setUint16(20, 1, true);
  h.setUint16(22, 1, true);
  h.setUint32(24, TARGET_RATE, true);
  h.setUint32(28, TARGET_RATE * 2, true);
  h.setUint16(32, 2, true);
  h.setUint16(34, 16, true);
  text(36, "data");
  h.setUint32(40, pcm.byteLength, true);
  return new Blob([header, pcm.buffer as ArrayBuffer], { type: "audio/wav" });
}

/** Sends a recording to be written out as text. */
export async function listen(wav: Blob, signal?: AbortSignal): Promise<string> {
  const res = await fetch("/api/voice/listen", {
    method: "POST",
    headers: { "content-type": "audio/wav", "x-language": navigator.language || "" },
    body: wav,
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? "Couldn't hear that. Try again.");
  return body.text ?? "";
}

/**
 * Reads text aloud: in the family's provider voice when it can, otherwise in the browser's own
 * voice. Resolves when it has finished, or straight away if `signal` aborts.
 */
export async function say(text: string, signal: AbortSignal, onFallback?: (why: string) => void): Promise<void> {
  const ctx = shared;
  if (!speakable(text)) return;
  let audio: { pcm: ArrayBuffer; rate: number } | null = null;
  try {
    const res = await fetch("/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      // A slow voice service shouldn't stall the conversation: the browser's voice takes over.
      signal: within(signal, 25_000),
    });
    if (res.ok) audio = { pcm: await res.arrayBuffer(), rate: Number(res.headers.get("x-sample-rate") ?? 24_000) };
    else onFallback?.(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "The voice service didn't answer.");
  } catch {
    if (signal.aborted) return;
    onFallback?.("The voice service took too long.");
  }
  if (signal.aborted) return;
  if (audio && audio.pcm.byteLength > 1 && ctx) {
    if (!micOpen()) setAudioSession("playback");
    return playPcm(ctx, audio.pcm, audio.rate, signal);
  }
  return sayWithBrowser(text, signal);
}

function playPcm(ctx: AudioContext, bytes: ArrayBuffer, rate: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const samples = new Int16Array(bytes, 0, Math.floor(bytes.byteLength / 2));
    const buffer = ctx.createBuffer(1, samples.length, rate);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 0x8000;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    let finished = false;
    const end = () => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", stop);
      resolve();
    };
    const stop = () => {
      try {
        src.stop();
      } catch {
        // Not started yet.
      }
      end();
    };
    src.onended = end;
    signal.addEventListener("abort", stop, { once: true });
    // iPhones can drop the "ended" event after an interruption; never wait past the sound's length.
    setTimeout(end, (samples.length / rate) * 1000 + 1500);
    if (ctx.state !== "running") ctx.resume().catch(() => {});
    src.start();
  });
}

function sayWithBrowser(text: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    const u = new SpeechSynthesisUtterance(speakable(text));
    u.rate = 1.02;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", stop);
      resolve();
    };
    const stop = () => {
      window.speechSynthesis.cancel();
      done();
    };
    u.onend = done;
    u.onerror = done;
    signal.addEventListener("abort", stop, { once: true });
    // Safari sometimes never reports the end; allow about 12 characters a second, then move on.
    setTimeout(done, (u.text.length / 12) * 1000 + 3000);
    window.speechSynthesis.speak(u);
  });
}

/**
 * Only one thing reads aloud at a time. Starting a new one stops the last; `stopSpeaking()` stops
 * whatever is playing.
 */
let current: AbortController | null = null;
export function startSpeaking(): AbortController {
  current?.abort();
  current = new AbortController();
  return current;
}
export function stopSpeaking() {
  current?.abort();
  current = null;
}
