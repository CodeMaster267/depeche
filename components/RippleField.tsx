"use client";

import { useEffect, useRef, useState } from "react";
import { letterflip, rippleMode, type RippleMode } from "@/lib/ripple/letterflip";

/** What the field repeats: the wordmark, lowercase, as a faint wall of type. */
const WORDS = "depeche  depeche   depeche  depeche    depeche   depeche ";

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
    if (!mode || !canvas.current) return;
    return letterflip(canvas.current, { text: WORDS, clearSelector: clear, mode }) ?? undefined;
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
