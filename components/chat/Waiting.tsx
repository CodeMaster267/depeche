"use client";

import { useEffect, useRef, useState } from "react";

/** Characters a letter runs through before it settles, like a split-flap board. */
const GLYPHS = "abcdefghijklmnopqrstuvwxyz0123456789/<>*#";

/** What the waiting line says, by how long the reply has been waiting. */
export function waitingPhrase(seconds: number, model: string): string {
  if (seconds < 2) return `asking ${model}`;
  if (seconds < 7) return "thinking";
  if (seconds < 16) return "still thinking";
  return "working on a long answer";
}

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Shown under a reply before its first word arrives: a short status that changes as the wait goes
 * on ("asking Sonnet 5.5", "thinking", "still thinking"), a seconds counter after a few seconds,
 * and a scan line. When the status changes its letters flip through other characters and settle
 * left to right; only the flipping letters get the red and cyan split, never the settled text.
 * Reduced motion: the words change without flipping and the scan line stays still.
 */
export function Waiting({ model, since }: { model: string; since?: number }) {
  const start = useRef(since ?? Date.now());
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const tick = () => setSeconds(Math.floor((Date.now() - start.current) / 1000));
    tick();
    const id = window.setInterval(tick, 250);
    return () => clearInterval(id);
  }, []);
  const phrase = waitingPhrase(seconds, model);
  const letters = useFlip(phrase);
  return (
    <div role="status" aria-label="Waiting for the answer" data-testid="waiting" className="waiting flex items-center gap-3">
      <span aria-hidden="true" className="waiting-signal">
        <i />
        <i />
        <i />
      </span>
      <span aria-hidden="true" className="font-mono text-[13px] tracking-[0.02em] text-mute">
        {letters.map((l, i) => (
          <span key={i} className={l.flipping ? "waiting-flip" : undefined}>
            {l.ch}
          </span>
        ))}
      </span>
      <span className="sr-only">{phrase}</span>
      {seconds >= 3 ? (
        <span aria-hidden="true" className="font-mono text-[12px] tabular-nums text-faint">
          {seconds}s
        </span>
      ) : null}
    </div>
  );
}

/** The phrase as letters, flipping through glyphs for a moment whenever the phrase changes. */
function useFlip(target: string): { ch: string; flipping: boolean }[] {
  const [shown, setShown] = useState(() => [...target].map((ch) => ({ ch, flipping: false })));
  useEffect(() => {
    if (reducedMotion()) {
      setShown([...target].map((ch) => ({ ch, flipping: false })));
      return;
    }
    const began = performance.now();
    let frame = 0;
    let last = -Infinity;
    const step = () => {
      const t = performance.now() - began;
      // A new glyph every few frames reads as flipping; every frame is just noise.
      if (t - last < 50) {
        frame = requestAnimationFrame(step);
        return;
      }
      last = t;
      const next = [...target].map((ch, i) => {
        // Each letter settles a little after the one before it.
        const settle = 140 + i * 28;
        if (t >= settle || ch === " ") return { ch, flipping: false };
        return { ch: GLYPHS[Math.floor(Math.random() * GLYPHS.length)], flipping: true };
      });
      setShown(next);
      if (next.some((l) => l.flipping)) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return shown;
}
