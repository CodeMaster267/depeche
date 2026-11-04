"use client";

import { useEffect, useRef, useState } from "react";
import { letterflip, rippleMode, type Letterflip, type RippleMode } from "@/lib/ripple/letterflip";

/** What the field repeats: the wordmark, lowercase, as a faint wall of type. */
const WORDS = "depeche  depeche   depeche  depeche    depeche   depeche ";
const START_AFTER_MS = 1200;

/**
 * The letterflip ripple behind a page (sign-in, empty new chat). With a mouse it follows the
 * pointer; on phones, tablets and touch screens it drifts on its own like slow waves. Anyone who
 * asked for less motion gets the plain page, with nothing added to it. `clear` names elements
 * inside the same parent that the letters stay away from, so what people read is never covered.
 * The canvas covers its positioned parent.
 */
export function RippleField({ clear, className = "absolute inset-0" }: { clear?: string; className?: string }) {
  const [mode, setMode] = useState<RippleMode | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const queries = ["(hover: hover) and (pointer: fine)", "(prefers-reduced-motion: reduce)"].map((q) => matchMedia(q));
    const check = () => setMode(rippleMode());
    check();
    for (const q of queries) q.addEventListener("change", check);
    return () => {
      for (const q of queries) q.removeEventListener("change", check);
    };
  }, []);

  useEffect(() => {
    const el = canvas.current;
    if (!mode || !el) return;
    // Start once the page has settled, so setting up WebGL never competes with the page itself
    // loading or with someone's first tap. The field fades in, so the wait isn't visible.
    let stop: (() => void) | null | undefined;
    const timer = window.setTimeout(() => {
      stop = letterflip(el, { text: WORDS, clearSelector: clear, mode });
    }, START_AFTER_MS);
    return () => {
      clearTimeout(timer);
      stop?.();
    };
  }, [mode, clear]);

  if (!mode) return null;
  // A new canvas per mode: a WebGL canvas can't be handed a fresh context once its old one is freed.
  return (
    <canvas
      key={mode}
      ref={canvas}
      aria-hidden="true"
      data-testid="ripple"
      data-mode={mode}
      className={`ripple-field pointer-events-none text-fg ${className}`}
    />
  );
}

/**
 * A soft ripple behind an open chat: when the chat opens, a burst of waves washes through faint
 * letters and fades to stillness in a few seconds; each new answer (`pulseKey` changes) sends a
 * fainter one. In between nothing runs. The letters are invisible at rest and only faintly lit, so
 * the conversation stays easy to read. Off with reduced motion, and still on devices that can't
 * keep up. The canvas covers its positioned parent.
 */
export function ChatRipple({ pulseKey, className = "absolute inset-0" }: { pulseKey: number; className?: string }) {
  const [on, setOn] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const field = useRef<Letterflip | null>(null);

  useEffect(() => {
    const q = matchMedia("(prefers-reduced-motion: reduce)");
    const check = () => setOn(rippleMode() !== null);
    check();
    q.addEventListener("change", check);
    return () => q.removeEventListener("change", check);
  }, []);

  useEffect(() => {
    const el = canvas.current;
    if (!on || !el) return;
    const timer = window.setTimeout(() => {
      field.current = letterflip(el, { text: WORDS, mode: "pulse", soft: true });
      field.current?.pulse(1, 1500);
    }, START_AFTER_MS);
    return () => {
      clearTimeout(timer);
      field.current?.();
      field.current = null;
    };
  }, [on]);

  // A new answer: a fainter wave.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    field.current?.pulse(0.55, 700);
  }, [pulseKey]);

  if (!on) return null;
  return (
    <canvas
      ref={canvas}
      aria-hidden="true"
      data-testid="chat-ripple"
      className={`ripple-field pointer-events-none text-fg ${className}`}
    />
  );
}
