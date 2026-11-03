import type { CSSProperties } from "react";

/**
 * The Depeche wordmark. `glitch` adds the title-card effect, modelled on Hasan's reference: a
 * strong red/cyan channel split, thin horizontal slices knocked sideways, smeared streak bands and
 * a few pixel shards. Everywhere else the wordmark stays clean.
 *
 * Sizes are in em, so the effect scales with the wordmark. Positions are fixed (not random) so the
 * server and browser render the same thing.
 */

type Slice = { top: number; height: number; dx: number; split?: number; streak?: boolean };

// top/height in % of the wordmark's height; dx and split in em.
const SLICES: Slice[] = [
  { top: 14, height: 6, dx: 0.06 },
  { top: 33, height: 4, dx: 0.14, split: 0.1, streak: true },
  { top: 47, height: 9, dx: -0.05 },
  { top: 68, height: 3, dx: -0.12, streak: true },
  { top: 80, height: 6, dx: 0.04, split: 0.09 },
];

// x/y in % of the wordmark box; w/h in em.
const SHARDS: { x: number; y: number; w: number; h: number; tone: "r" | "c" | "w" }[] = [
  { x: 2, y: 30, w: 0.16, h: 0.04, tone: "c" },
  { x: 38, y: 90, w: 0.12, h: 0.04, tone: "r" },
  { x: 71, y: 8, w: 0.08, h: 0.07, tone: "r" },
  { x: 93, y: 66, w: 0.14, h: 0.04, tone: "c" },
];

// Thin light streaks that run past the letters, like the smeared highlights in the reference.
const LINES = [
  { top: 35, left: -4, width: 38, tone: "c" as const },
  { top: 69.5, left: 62, width: 44, tone: "r" as const },
];

/** Removes the sliced bands from the base layer, so each band appears only in its shifted place. */
function baseClip(): string {
  const pts: string[] = ["0 0", "100% 0"];
  for (const s of SLICES) {
    pts.push(`100% ${s.top}%`, `0 ${s.top}%`, `0 ${s.top + s.height}%`, `100% ${s.top + s.height}%`);
  }
  pts.push("100% 100%", "0 100%");
  return `polygon(${pts.join(", ")})`;
}

function Channels({ split }: { split?: number }) {
  const style = split ? ({ "--split": `${split}em` } as CSSProperties) : undefined;
  return (
    <span className="layer" aria-hidden="true" style={style}>
      <span className="ch r">Depeche</span>
      <span className="ch c">Depeche</span>
      <span className="ch w">Depeche</span>
    </span>
  );
}

export function Wordmark({ glitch = false, className = "" }: { glitch?: boolean; className?: string }) {
  if (!glitch) return <span className={`wordmark ${className}`}>Depeche</span>;

  return (
    <span className={`wordmark glitch ${className}`} role="img" aria-label="Depeche">
      <span className="base" style={{ clipPath: baseClip() }}>
        <Channels />
      </span>
      {SLICES.map((s, i) => (
        <span
          key={i}
          className={`slice${s.streak ? " streak" : ""}`}
          style={
            {
              clipPath: `inset(${s.top}% -1em ${100 - s.top - s.height}% -1em)`,
              "--dx": `${s.dx}em`,
              animationDelay: `${(i % 4) * 60}ms`,
            } as CSSProperties
          }
        >
          <Channels split={s.split} />
        </span>
      ))}
      {LINES.map((l, i) => (
        <span
          key={`l${i}`}
          className={`streak-line ${l.tone}`}
          aria-hidden="true"
          style={{ top: `${l.top}%`, left: `${l.left}%`, width: `${l.width}%` }}
        />
      ))}
      {SHARDS.map((s, i) => (
        <span
          key={`s${i}`}
          className={`shard ${s.tone}`}
          aria-hidden="true"
          style={{ left: `${s.x}%`, top: `${s.y}%`, width: `${s.w}em`, height: `${s.h}em` }}
        />
      ))}
    </span>
  );
}
