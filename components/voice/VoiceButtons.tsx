"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, listen, micSupported, say, startSpeaking, unlockAudio } from "@/lib/voice/client";
import { MicIcon, SpeakerIcon, StopSpeakingIcon, WaveIcon } from "./icons";

/** Whether this browser can record; false on the server and until the page has loaded. */
function useMicSupported() {
  const [ok, setOk] = useState(false);
  useEffect(() => setOk(micSupported()), []);
  return ok;
}

/** Words for a microphone that couldn't be opened, per browser's reason. */
export function micProblem(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Depeche isn't allowed to use the microphone. On iPhone: Settings › Apps › Safari › Microphone, then allow depai.vercel.app.";
  if (name === "NotFoundError") return "No microphone found on this device.";
  return "Couldn't start the microphone. Try again.";
}

/**
 * The mic in the message box: tap, speak, tap again, and what you said is written into the box
 * to check before sending.
 */
export function DictateButton({ onText, onError, disabled }: { onText: (t: string) => void; onError: (msg: string) => void; disabled?: boolean }) {
  const [state, setState] = useState<"idle" | "recording" | "working">("idle");
  const [level, setLevel] = useState(0);
  const mic = useRef<Mic | null>(null);
  const supported = useMicSupported();

  useEffect(() => () => mic.current?.cancel(), []);

  const finish = async () => {
    const rec = mic.current;
    mic.current = null;
    if (!rec) return;
    const heard = rec.heardSpeech;
    const wav = rec.stop();
    setLevel(0);
    if (!heard) {
      setState("idle");
      return onError("Didn't catch anything. Tap the mic and speak.");
    }
    setState("working");
    try {
      const text = await listen(wav);
      if (text) onText(text);
      else onError("Didn't catch anything. Tap the mic and speak.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Couldn't hear that. Try again.");
    } finally {
      setState("idle");
    }
  };

  const toggle = async () => {
    if (state === "recording") return finish();
    if (state !== "idle") return;
    const ctx = unlockAudio();
    try {
      mic.current = await Mic.open(ctx, { onLevel: setLevel, onAutoStop: () => finish() });
      setState("recording");
    } catch (e) {
      console.warn("[voice] microphone", (e as Error)?.name, (e as Error)?.message);
      onError(micProblem(e));
    }
  };

  if (!supported) return null;
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled || state === "working"}
      aria-label={state === "recording" ? "Stop and write it out" : state === "working" ? "Writing out what you said" : "Dictate"}
      aria-pressed={state === "recording"}
      className="press relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-mute hover:text-fg disabled:opacity-40 aria-pressed:text-fg"
    >
      {state === "recording" ? (
        <span
          aria-hidden
          className="absolute inset-1 rounded-full border border-fg transition-transform duration-75"
          style={{ transform: `scale(${1 + level * 0.35})` }}
        />
      ) : null}
      {state === "working" ? <span aria-hidden className="voice-dots" /> : <MicIcon />}
    </button>
  );
}

/** Opens hands-free voice chat. */
export function VoiceChatButton({ onOpen, disabled }: { onOpen: () => void; disabled?: boolean }) {
  const supported = useMicSupported();
  if (!supported) return null;
  return (
    <button
      type="button"
      onClick={() => {
        unlockAudio();
        onOpen();
      }}
      disabled={disabled}
      aria-label="Voice chat"
      className="press glass flex h-11 w-11 shrink-0 items-center justify-center rounded-full disabled:opacity-30"
    >
      <WaveIcon />
    </button>
  );
}

/** The speaker under a reply: reads it aloud, tap again to stop. */
export function ReadAloudButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => () => ctl.current?.abort(), []);

  const toggle = async () => {
    if (state !== "idle") {
      ctl.current?.abort();
      return;
    }
    unlockAudio();
    const c = startSpeaking();
    ctl.current = c;
    setState("loading");
    c.signal.addEventListener("abort", () => setState("idle"), { once: true });
    // "loading" until sound starts is hard to know for the browser voice; a short wait is enough.
    const t = setTimeout(() => !c.signal.aborted && setState("playing"), 900);
    await say(text, c.signal);
    clearTimeout(t);
    setState("idle");
  };

  return (
    <button
      type="button"
      className="rounded-lg p-2 hover:text-fg"
      aria-label={state === "idle" ? "Read aloud" : "Stop reading"}
      aria-pressed={state !== "idle"}
      onClick={toggle}
    >
      {state === "idle" ? <SpeakerIcon /> : state === "loading" ? <span aria-hidden className="voice-dots" /> : <StopSpeakingIcon />}
    </button>
  );
}
