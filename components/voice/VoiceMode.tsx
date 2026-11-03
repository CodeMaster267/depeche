"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, closeMicStream, listen, openMicStream, say, startSpeaking, stopSpeaking, unlockAudio } from "@/lib/voice/client";
import { readyToSpeak, speakable } from "@/lib/voice/text";
import { micProblem } from "./VoiceButtons";

export type VoiceMessage = { id: string; role: string; content: { text?: string; error?: string }; status: string; streaming?: boolean };

type Phase = "starting" | "listening" | "hearing" | "thinking" | "speaking" | "paused";

const LABEL: Record<Phase, string> = {
  starting: "Starting…",
  listening: "Listening",
  hearing: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  paused: "Tap to talk",
};

/**
 * Hands-free voice chat, over the open chat. It listens until you stop talking, sends what you
 * said as a normal message, reads the reply aloud as it is written, then listens again. Tap the
 * circle to interrupt. Everything said and answered is saved in the chat like typed messages.
 * Works while the app is open; iPhones don't let websites listen in the background.
 */
export function VoiceMode({
  messages,
  busy,
  banner,
  onSend,
  onStop,
  onClose,
}: {
  messages: VoiceMessage[];
  busy: boolean;
  banner: string | null;
  onSend: (text: string) => void;
  onStop: () => void;
  onClose: () => void;
}) {
  const [phase, setPhaseState] = useState<Phase>("starting");
  const [level, setLevel] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const phaseRef = useRef<Phase>("starting");
  const setPhase = (p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  };
  const open = useRef(true);
  const mic = useRef<Mic | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const speech = useRef<AbortController | null>(null);
  const queue = useRef<string[]>([]);
  const spoken = useRef(0);
  const base = useRef(0);
  const sending = useRef(false);
  const empties = useRef(0);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  // The chat's send changes as the chat does (a new chat gets its id); always call the latest.
  const sendRef = useRef(onSend);
  sendRef.current = onSend;

  const reply = (): VoiceMessage | undefined => {
    const list = messagesRef.current;
    // The send adds your message and the reply's placeholder together.
    return sending.current && list.length >= base.current + 2 && list.at(-1)?.role === "assistant" ? list.at(-1) : undefined;
  };

  const startListening = useCallback(async () => {
    if (!open.current) return;
    mic.current?.cancel();
    setNote(null);
    setPhase("listening");
    try {
      const ctx = unlockAudio();
      // One microphone for the whole conversation; reopened only if the system took it away.
      if (!stream.current || stream.current.getAudioTracks().every((t) => t.readyState === "ended")) {
        stream.current = await openMicStream();
      }
      if (!open.current) return;
      mic.current = await Mic.open(ctx, {
        autoStop: true,
        onLevel: setLevel,
        onAutoStop: (heard) => (heard ? hear() : pause("Didn't hear anything. Tap to talk.")),
      }, stream.current);
      if (!open.current) mic.current.cancel();
    } catch (e) {
      console.warn("[voice] microphone", (e as Error)?.name, (e as Error)?.message);
      pause(micProblem(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pause = (why: string | null) => {
    mic.current?.cancel();
    mic.current = null;
    setLevel(0);
    setNote(why);
    setPhase("paused");
  };

  const hear = async () => {
    const rec = mic.current;
    mic.current = null;
    if (!rec || !open.current) return;
    const wav = rec.stop();
    setLevel(0);
    setPhase("hearing");
    let text = "";
    try {
      text = (await listen(wav)).trim();
    } catch (e) {
      return pause(e instanceof Error ? e.message : "Couldn't hear that.");
    }
    if (!open.current) return;
    if (!text) {
      empties.current++;
      return empties.current >= 2 ? pause("Didn't catch that. Tap to talk.") : startListening();
    }
    empties.current = 0;
    setSaid(text);
    base.current = messagesRef.current.length;
    spoken.current = 0;
    queue.current = [];
    sending.current = true;
    setPhase("thinking");
    sendRef.current(text);
  };

  const pump = async () => {
    if (speech.current || !open.current) return;
    const next = queue.current.shift();
    const r = reply();
    if (!next) {
      // Everything is said and the reply is finished: your turn.
      if (r && !r.streaming && sending.current) {
        sending.current = false;
        if (r.status === "failed") return pause(r.content.error ?? "Something went wrong.");
        startListening();
      }
      return;
    }
    setPhase("speaking");
    const c = startSpeaking();
    speech.current = c;
    await say(next, c.signal);
    if (speech.current === c) speech.current = null;
    if (!c.signal.aborted) pump();
  };

  // Follow the reply as it streams in, speaking each ready piece.
  useEffect(() => {
    if (!sending.current) return;
    const r = reply();
    if (!r) {
      // The send was refused (a limit, no key): nothing will arrive.
      if (!busy && banner && phaseRef.current === "thinking") {
        sending.current = false;
        pause(banner);
      }
      return;
    }
    const text = r.content.text ?? "";
    const { ready } = readyToSpeak(text.slice(spoken.current), !r.streaming, spoken.current === 0);
    // Pieces that are only symbols or code have nothing to say aloud.
    if (speakable(ready)) queue.current.push(ready);
    spoken.current += ready.length;
    pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, busy, banner]);

  // Start listening on open; let go of the mic and stop talking on close.
  useEffect(() => {
    open.current = true;
    startListening();
    let lock: { release: () => Promise<void> } | null = null;
    // Keep the screen on while talking, where the browser allows it.
    (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<typeof lock> } }).wakeLock
      ?.request("screen")
      .then((l) => (lock = l))
      .catch(() => {});
    return () => {
      open.current = false;
      mic.current?.cancel();
      closeMicStream(stream.current);
      stream.current = null;
      speech.current?.abort();
      stopSpeaking();
      lock?.release().catch(() => {});
    };
  }, [startListening]);

  const tap = () => {
    unlockAudio();
    const p = phaseRef.current;
    if (p === "listening") {
      if (mic.current?.heardSpeech) hear();
      return;
    }
    if (p === "speaking" || p === "thinking") {
      // Interrupt: stop talking (and writing), and listen.
      queue.current = [];
      speech.current?.abort();
      speech.current = null;
      if (busy) onStop();
      sending.current = false;
      startListening();
      return;
    }
    if (p === "paused") startListening();
  };

  const scale = phase === "listening" ? 1 + level * 0.5 : 1;
  return (
    <div role="dialog" aria-modal="true" aria-label="Voice chat" className="enter-glitch fixed inset-0 z-50 flex flex-col bg-bg">
      <div className="flex justify-end px-4" style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}>
        <button type="button" onClick={onClose} className="press rounded-full border border-line px-4 py-2 text-[15px]">
          End
        </button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-10 px-8">
        <button
          type="button"
          onClick={tap}
          data-phase={phase}
          aria-label={
            phase === "speaking" || phase === "thinking" ? "Interrupt" : phase === "paused" ? "Tap to talk" : "Send now"
          }
          className={`voice-orb flex h-44 w-44 items-center justify-center rounded-full bg-fg ${phase === "thinking" || phase === "hearing" ? "voice-orb-busy" : ""} ${phase === "speaking" ? "voice-orb-speaking" : ""} ${phase === "paused" ? "opacity-30" : ""}`}
          style={{ transform: `scale(${scale})` }}
        />
        <div className="flex min-h-[7rem] max-w-[34rem] flex-col items-center gap-3 text-center">
          <p aria-live="polite" className="text-[20px] font-semibold">
            {LABEL[phase]}
          </p>
          {note ? (
            <p role="alert" className="text-[15px] text-mute">
              {note}
            </p>
          ) : said ? (
            <p className="line-clamp-3 text-[15px] text-mute">“{said}”</p>
          ) : (
            <p className="text-[15px] text-mute">Talk, then pause. Tap the circle to interrupt.</p>
          )}
        </div>
      </div>
      <p className="px-8 text-center text-[12px] text-faint" style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}>
        Saved in this chat like typed messages. Voice works while Depeche is open.
      </p>
    </div>
  );
}
