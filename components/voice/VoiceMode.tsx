"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, closeMicStream, fetchVoice, listen, openMicStream, playVoice, startSpeaking, stopSpeaking, unlockAudio, within, type Voiced } from "@/lib/voice/client";
import { readyToSpeak, speakable } from "@/lib/voice/text";
import { micProblem } from "./VoiceButtons";
import { CloseIcon, MicIcon, MicOffIcon, SpeakerIcon, SpeakerOffIcon } from "./icons";
import { LanguagePicker } from "./LanguagePicker";
import { openLive, type Listener } from "@/lib/voice/live";

const TALK_OVER_KEY = "depeche:voice-talk-over";
const readTalkOver = () => {
  try {
    return localStorage.getItem(TALK_OVER_KEY) !== "off";
  } catch {
    return true;
  }
};
/** Two words in a row while it's answering means the person is talking, not a cough. */
const talking = (t: string) => t.trim().split(/\s+/).filter(Boolean).length >= 2;

export type VoiceMessage = { id: string; role: string; content: { text?: string; error?: string }; status: string; streaming?: boolean };

type Phase = "starting" | "listening" | "hearing" | "thinking" | "speaking" | "paused" | "muted";

const LABEL: Record<Phase, string> = {
  starting: "Starting…",
  listening: "Listening",
  hearing: "Writing out what you said…",
  thinking: "Thinking…",
  speaking: "Speaking",
  paused: "Tap to talk",
  muted: "Mic off",
};

/** How long each step may take before voice chat gives up and says so, instead of hanging. */
const HEAR_TIMEOUT_MS = 30_000;
const ANSWER_TIMEOUT_MS = 60_000;

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
  const [muted, setMutedState] = useState(false);
  const mutedRef = useRef(false);
  /** Where the latest answer sits in the chat, so its captions stay up until you speak again. */
  const [answerAt, setAnswerAt] = useState<number | null>(null);
  const captions = useRef<HTMLDivElement>(null);
  const phaseRef = useRef<Phase>("starting");
  const setPhase = (p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  };
  const open = useRef(true);
  const mic = useRef<Mic | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const speech = useRef<AbortController | null>(null);
  /** Pieces of the answer waiting to be said. The next one's audio is made while one plays. */
  const queue = useRef<{ text: string; voiced?: Promise<Voiced> }[]>([]);
  /** Live listening (words appear as you talk), while it works; null means the usual way. */
  const live = useRef<Listener | null>(null);
  const liveOff = useRef(false);
  /** Talk over the answer to cut it off. Keeps the mic open while it speaks. */
  const [talkOver, setTalkOverState] = useState(true);
  const talkOverRef = useRef(true);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const stopRef = useRef(onStop);
  stopRef.current = onStop;
  /** Cancels everything for the current answer: audio being made and audio playing. */
  const answerCtl = useRef<AbortController | null>(null);
  /** Once the provider's voice fails, the rest of the conversation uses the device's voice. */
  const deviceVoice = useRef(false);
  const [soundOff, setSoundOffState] = useState(false);
  const soundOffRef = useRef(false);
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

  /** The live listener, opening one if needed; null when live listening isn't available. */
  const getLive = async (): Promise<Listener | null> => {
    if (live.current && !live.current.closed) return live.current;
    live.current = null;
    if (liveOff.current) return null;
    const l = await openLive();
    if (!l) {
      // No Google key, or Google said no: the usual listening for the rest of this conversation.
      liveOff.current = true;
      return null;
    }
    if (!open.current) {
      l.close();
      return null;
    }
    l.events.onText = (t) => heardLive(t);
    live.current = l;
    return l;
  };
  const liveUp = () => !!live.current && !live.current.closed;

  /** Words from live listening, as they're said. */
  const heardLive = (t: string) => {
    const p = phaseRef.current;
    if (p === "listening") {
      if (t) {
        setSaid(t);
        setAnswerAt(null);
      }
    } else if ((p === "speaking" || p === "thinking") && talkOverRef.current && talking(t)) {
      // Talking over the answer: stop it and carry on listening, keeping what's been said.
      console.info("[voice] talked over the answer");
      interrupt();
      setSaid(t);
      setAnswerAt(null);
      setNote(null);
      setPhase("listening");
      mic.current?.restart(true);
    }
  };

  const micStreamUp = () => !!stream.current && stream.current.getAudioTracks().some((t) => t.readyState !== "ended");

  /** Listens for your turn. With the mic muted it waits for a tap instead (`once` is that tap). */
  const startListening = useCallback(async (once = false) => {
    if (!open.current) return;
    if (mutedRef.current && !once) {
      mic.current?.cancel();
      mic.current = null;
      closeMicStream(stream.current);
      stream.current = null;
      setLevel(0);
      setNote(null);
      return setPhase("muted");
    }
    setNote(null);
    // Still listening from while the answer played: just start the turn over.
    if (mic.current && liveUp() && micStreamUp()) {
      live.current!.reset();
      mic.current.restart(true);
      return setPhase("listening");
    }
    mic.current?.cancel();
    mic.current = null;
    setPhase("listening");
    try {
      const ctx = unlockAudio();
      // The microphone is open only while it's your turn (or while you can talk over the answer).
      if (!micStreamUp()) stream.current = await openMicStream();
      const l = await getLive();
      if (!open.current) return;
      l?.reset();
      mic.current = await openMic(ctx, true);
      if (!open.current) mic.current.cancel();
    } catch (e) {
      console.warn("[voice] microphone", (e as Error)?.name, (e as Error)?.message);
      pause(micProblem(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openMic = (ctx: AudioContext, autoStop: boolean) =>
    Mic.open(
      ctx,
      {
        autoStop,
        onLevel: setLevel,
        // With live listening the words are already written out, so a shorter pause will do.
        quietMs: liveUp() ? 900 : undefined,
        onChunk: (pcm) => live.current?.send(pcm),
        onAutoStop: (heard) => (heard ? hear() : pause("Didn't hear anything. Tap to talk.")),
      },
      stream.current!,
    );

  /** While the answer plays, keep listening so you can talk over it. */
  const overhear = async () => {
    if (!talkOverRef.current || mutedRef.current || !liveUp() || !micStreamUp() || !open.current) return;
    // Only what's said from now on counts.
    live.current!.reset();
    try {
      mic.current = await openMic(unlockAudio(), false);
    } catch {
      mic.current = null;
    }
  };

  /** Stops the answer: what's playing, what's being made and what's being written. */
  const interrupt = () => {
    queue.current = [];
    answerCtl.current?.abort();
    speech.current?.abort();
    speech.current = null;
    stopSpeaking();
    if (busyRef.current) stopRef.current();
    sending.current = false;
  };

  const pause = (why: string | null) => {
    mic.current?.cancel();
    mic.current = null;
    closeMicStream(stream.current);
    stream.current = null;
    setLevel(0);
    setNote(why);
    setPhase("paused");
  };

  const hear = async () => {
    const rec = mic.current;
    mic.current = null;
    if (!rec || !open.current) return;
    const wav = rec.stop();
    const keepMic = talkOverRef.current && !mutedRef.current && liveUp();
    if (!keepMic) {
      // Let go of the microphone until it's your turn again, so the answer plays like media:
      // through headphones when they're in, at full volume.
      closeMicStream(stream.current);
      stream.current = null;
    }
    setLevel(0);
    setPhase("hearing");
    let text = "";
    try {
      if (liveUp()) text = (await live.current!.finish()).trim();
      // Nothing came back live: write out the recording the usual way.
      if (!text) text = (await listen(wav, within(undefined, HEAR_TIMEOUT_MS))).trim();
    } catch (e) {
      const late = ["TimeoutError", "AbortError"].includes((e as Error)?.name);
      console.warn("[voice] writing out", (e as Error)?.name, (e as Error)?.message);
      return pause(late ? "Writing out what you said took too long. Tap to try again." : e instanceof Error ? e.message : "Couldn't hear that.");
    }
    if (!open.current) return;
    if (!text) {
      empties.current++;
      return empties.current >= 2 ? pause("Didn't catch that. Tap to talk.") : startListening();
    }
    empties.current = 0;
    setSaid(text);
    base.current = messagesRef.current.length;
    setAnswerAt(base.current + 1);
    spoken.current = 0;
    queue.current = [];
    answerCtl.current?.abort();
    answerCtl.current = new AbortController();
    sending.current = true;
    setPhase("thinking");
    sendRef.current(text);
    overhear();
    // If no answer starts arriving, say so rather than flicker forever.
    const sentAt = base.current;
    setTimeout(() => {
      if (!open.current || !sending.current || base.current !== sentAt || phaseRef.current !== "thinking") return;
      if (reply()?.content.text) return;
      sending.current = false;
      pause("No answer came back. Tap to try again.");
    }, ANSWER_TIMEOUT_MS);
  };

  /** Starts making a piece's audio, if it hasn't been started yet. */
  const voice = (item: { text: string; voiced?: Promise<Voiced> }) => {
    if (item.voiced) return item.voiced;
    const signal = answerCtl.current?.signal ?? new AbortController().signal;
    item.voiced =
      soundOffRef.current || deviceVoice.current
        ? Promise.resolve({ fallback: "" })
        : fetchVoice(item.text, signal, true).then((v) => {
            if ("fallback" in v && !signal.aborted && !deviceVoice.current) {
              deviceVoice.current = true;
              setNote(`Using this device's voice. ${v.fallback}`);
            }
            return v;
          });
    return item.voiced;
  };

  const enqueue = (text: string) => {
    queue.current.push({ text });
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
    const voiced = await voice(next);
    // Make the next piece while this one plays (one at a time, so a fast reply doesn't run into
    // the limit on requests at once).
    if (queue.current[0] && !c.signal.aborted) voice(queue.current[0]);
    // Sound off: the captions carry the answer, nothing is played.
    if (!soundOffRef.current && !c.signal.aborted) await playVoice(next.text, voiced, c.signal);
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
    if (speakable(ready)) enqueue(ready);
    spoken.current += ready.length;
    pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, busy, banner]);

  // Start listening on open; let go of the mic and stop talking on close.
  useEffect(() => {
    open.current = true;
    talkOverRef.current = readTalkOver();
    setTalkOverState(talkOverRef.current);
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
      answerCtl.current?.abort();
      stopSpeaking();
      live.current?.close();
      live.current = null;
      lock?.release().catch(() => {});
    };
  }, [startListening]);

  // Keep the newest words of the answer in view.
  const answer = answerAt !== null && messages[answerAt]?.role === "assistant" ? messages[answerAt] : undefined;
  const answerText = answer ? speakable(answer.content.text ?? "") : "";
  useEffect(() => {
    const el = captions.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [answerText, said]);

  const toggleMute = () => {
    unlockAudio();
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMutedState(next);
    const p = phaseRef.current;
    if (next) {
      // Half-heard words won't be sent.
      if (p === "listening") setSaid("");
      // Stop listening now; anything being said still finishes, and a tap on the circle still
      // lets you talk.
      if (p === "listening" || p === "paused" || p === "starting") startListening();
    } else if (p === "muted" || p === "paused") startListening();
  };

  const toggleSound = () => {
    unlockAudio();
    const next = !soundOffRef.current;
    soundOffRef.current = next;
    setSoundOffState(next);
    // Turning sound off stops what's playing; the captions keep going.
    if (next) stopSpeaking();
  };

  const toggleTalkOver = () => {
    const next = !talkOverRef.current;
    talkOverRef.current = next;
    setTalkOverState(next);
    try {
      localStorage.setItem(TALK_OVER_KEY, next ? "on" : "off");
    } catch {
      // Remembered for this conversation only.
    }
    const p = phaseRef.current;
    if (next && (p === "speaking" || p === "thinking") && !mic.current) overhear();
    if (!next && (p === "speaking" || p === "thinking") && mic.current) {
      // Let go of the mic now, so the answer plays like media again.
      mic.current.cancel();
      mic.current = null;
      closeMicStream(stream.current);
      stream.current = null;
    }
  };

  const tap = () => {
    unlockAudio();
    const p = phaseRef.current;
    if (p === "listening") {
      if (mic.current?.heardSpeech) hear();
      return;
    }
    if (p === "speaking" || p === "thinking") {
      // Interrupt: stop talking (and writing), and listen.
      interrupt();
      startListening(true);
      return;
    }
    // Paused, or mic off: a tap means "my turn".
    if (p === "paused" || p === "muted") startListening(true);
  };

  const scale = phase === "listening" ? 1 + level * 0.5 : 1;
  const hint =
    phase === "listening"
      ? "Talk, then pause."
      : phase === "speaking" || phase === "thinking"
        ? talkOver && liveUp() && !muted
          ? "Talk, or tap the circle, to interrupt."
          : "Tap the circle to interrupt."
        : phase === "muted"
          ? "Tap the circle when you want to talk."
          : "";
  return (
    <div role="dialog" aria-modal="true" aria-label="Voice chat" className="enter-glitch fixed inset-0 z-50 flex flex-col bg-bg">
      <div className="flex flex-col items-center gap-5 px-6" style={{ paddingTop: "max(2.5rem, calc(env(safe-area-inset-top) + 1.5rem))" }}>
        <button
          type="button"
          onClick={tap}
          data-phase={phase}
          aria-label={
            phase === "speaking" || phase === "thinking" ? "Interrupt" : phase === "paused" || phase === "muted" ? "Tap to talk" : "Send now"
          }
          className={`voice-orb h-28 w-28 shrink-0 rounded-full bg-fg ${phase === "thinking" || phase === "hearing" ? "voice-orb-busy" : ""} ${phase === "speaking" ? "voice-orb-speaking" : ""} ${phase === "paused" || phase === "muted" ? "opacity-30" : ""}`}
          style={{ transform: `scale(${scale})` }}
        />
        <div className="flex flex-col items-center gap-1 text-center">
          <p aria-live="polite" className="text-[19px] font-semibold">
            {LABEL[phase]}
          </p>
          {note ? (
            <p role="alert" className="max-w-[30rem] text-[15px] text-mute">
              {note}
            </p>
          ) : hint ? (
            <p className="text-[15px] text-mute">{hint}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-start justify-center gap-2">
          <LanguagePicker
            onChange={() => {
              // Listen with the new languages from the next turn (this one is written out the usual way).
              live.current?.close();
              live.current = null;
              liveOff.current = false;
            }}
          />
          <button
            type="button"
            onClick={toggleTalkOver}
            aria-pressed={talkOver}
            className="press rounded-full border border-line px-3.5 py-1.5 text-[14px] text-mute"
          >
            Talk over answers: {talkOver ? "on" : "off"}
          </button>
        </div>
      </div>

      {/* Captions: what you said, then the answer as it is written and read out. */}
      <div ref={captions} className="mx-auto mt-6 flex min-h-0 w-full max-w-[40rem] flex-1 flex-col gap-4 overflow-y-auto px-6 pb-4" data-testid="voice-captions">
        {said ? (
          <div className="flex justify-end">
            <p data-testid="voice-you" className="max-w-[85%] rounded-[20px] bg-inv px-4 py-2.5 text-[16px] leading-snug text-on-inv">
              {said}
            </p>
          </div>
        ) : null}
        {answerText ? (
          <p data-testid="voice-answer" className="whitespace-pre-wrap text-[18px] leading-relaxed">
            {answerText}
          </p>
        ) : null}
      </div>

      <div className="flex items-center justify-center gap-10 px-6 pt-2" style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}>
        <button
          type="button"
          onClick={toggleMute}
          aria-pressed={muted}
          aria-label={muted ? "Unmute" : "Mute"}
          className={`press flex h-14 w-14 items-center justify-center rounded-full border ${muted ? "border-fg bg-fg text-bg" : "border-line"}`}
        >
          {muted ? <MicOffIcon /> : <MicIcon />}
        </button>
        <button
          type="button"
          onClick={toggleSound}
          aria-pressed={soundOff}
          aria-label={soundOff ? "Turn sound on" : "Turn sound off"}
          className={`press flex h-14 w-14 items-center justify-center rounded-full border ${soundOff ? "border-fg bg-fg text-bg" : "border-line"}`}
        >
          {soundOff ? <SpeakerOffIcon /> : <SpeakerIcon className="h-[22px] w-[22px]" />}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="End voice chat"
          className="press flex h-14 w-14 items-center justify-center rounded-full border border-line"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
