"use client";

import { useEffect, useRef, useState } from "react";
import { letterflip, rippleAllowed } from "@/lib/ripple/letterflip";

/** What the field repeats: the wordmark, lowercase, as a faint wall of type. */
const WORDS = "depeche  depeche   depeche  depeche    depeche   depeche ";

/**
 * The letterflip ripple behind a page (sign-in, empty new chat). Desktop with a mouse only: phones,
 * tablets, touch screens and anyone who asked for less motion get the plain page, with nothing
 * added to it. `clear` names elements inside the same parent that the letters stay away from, so
 * what people read is never covered. The canvas covers its positioned parent.
 */
export function RippleField({ clear, className = "absolute inset-0" }: { clear?: string; className?: string }) {
  const [allowed, setAllowed] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const queries = ["(hover: hover) and (pointer: fine)", "(prefers-reduced-motion: reduce)", "(min-width: 900px)"].map((q) => matchMedia(q));
    const check = () => setAllowed(rippleAllowed());
    check();
    for (const q of queries) q.addEventListener("change", check);
    return () => {
      for (const q of queries) q.removeEventListener("change", check);
    };
  }, []);

  useEffect(() => {
    if (!allowed || !canvas.current) return;
    return letterflip(canvas.current, { text: WORDS, clearSelector: clear }) ?? undefined;
  }, [allowed, clear]);

  if (!allowed) return null;
  return <canvas ref={canvas} aria-hidden="true" data-testid="ripple" className={`ripple-field pointer-events-none text-fg ${className}`} />;
}
