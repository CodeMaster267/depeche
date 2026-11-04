import { DEFAULT_DARK, DEFAULT_LIGHT, type Fill, type Palette, type Region, type Slot, type Spec, type TextSlot } from "./spec";

/**
 * Readability checks. Every design is checked in light and in dark before anyone sees it, using
 * the contrast ratios of the web's accessibility guidelines (WCAG 2): 4.5 to 1 for text people
 * read, 3 to 1 for buttons and the like. Colours that fail are nudged towards black or white until
 * they pass, so a design can be odd but never unreadable.
 */

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = ([r, g, b]: number[]) => `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;

export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white, whichever reads better on this colour. */
export function onColour(bg: string): string {
  return contrast("#000000", bg) >= contrast("#ffffff", bg) ? "#0a0a0a" : "#ffffff";
}

function mix(a: string, b: string, t: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return toHex(x.map((c, i) => c + (y[i] - c) * t));
}

/** Moves `text` towards black or white (whichever helps) until it has `min` contrast on every background. */
function nudge(text: string, backgrounds: string[], min: number): string {
  const ok = (c: string) => backgrounds.every((bg) => contrast(c, bg) >= min);
  if (ok(text)) return text;
  for (const target of ["#000000", "#ffffff"]) {
    for (let t = 0.1; t <= 1.001; t += 0.1) {
      const c = mix(text, target, t);
      if (ok(c)) return c;
    }
  }
  // Nothing passes on every background (they are too far apart): best effort on the first.
  return onColour(backgrounds[0]);
}

/** The pairs every palette must pass: [text, on these backgrounds, minimum ratio]. */
const RULES: [Slot, Slot[], number][] = [
  ["fg", ["bg", "surface", "soft"], 4.5],
  ["mute", ["bg", "surface"], 4.5],
  ["onInv", ["inv"], 4.5],
  // Links and highlights drawn in the accent, and buttons drawn in it, must stand out.
  ["accent", ["bg", "surface"], 3],
  ["accent2", ["bg", "surface"], 3],
  // Placeholders are hints, not content, but still have to be visible.
  ["faint", ["bg", "surface"], 2.3],
  ["line", ["bg"], 1.15],
];

export type Fix = { mode: "light" | "dark"; what: string };

/** Makes a palette pass every rule, saying what had to change. */
export function readablePalette(p: Palette, mode: "light" | "dark"): { palette: Palette; fixes: Fix[] } {
  const out = { ...p };
  const fixes: Fix[] = [];
  for (const [text, bgs, min] of RULES) {
    const before = out[text];
    const after = text === "line" ? nudgeLine(out.line, out.bg) : nudge(before, bgs.map((b) => out[b]), min);
    if (after !== before) {
      out[text] = after;
      fixes.push({ mode, what: text });
    }
  }
  // If the backgrounds themselves are too far apart for one text colour, fall back to the standard palette.
  if (RULES.some(([t, bgs, min]) => bgs.some((b) => contrast(out[t], out[b]) < min))) {
    return { palette: mode === "light" ? DEFAULT_LIGHT : DEFAULT_DARK, fixes: [...fixes, { mode, what: "all" }] };
  }
  return { palette: out, fixes };
}

/** Lines are decoration, but should be just visible: a touch darker (or lighter) than the background. */
function nudgeLine(line: string, bg: string): string {
  if (contrast(line, bg) >= 1.15) return line;
  return mix(bg, onColour(bg), 0.12);
}

/** The colours a fill can be, in one palette (both ends of a gradient). */
function fillColours(f: Fill | undefined, p: Palette, fallback: string): string[] {
  if (!f) return [fallback];
  if (f === "transparent") return [fallback];
  if (typeof f === "string") return [p[f]];
  return [p[f.from], p[f.to]];
}

/** The background each region sits on when it sets none of its own. */
const BEHIND: Partial<Record<Region, Slot>> = { sidebar: "surface", "chat-item": "surface", "user-message": "inv" };
/** The text colour each region uses when it sets none of its own. */
const DEFAULT_TEXT: Partial<Record<Region, TextSlot>> = { "send-button": "auto", "main-buttons": "auto", "user-message": "onInv" };

/**
 * Region text must read on the region's own background in both palettes. A region whose colours
 * fail gets "auto" text (black or white, chosen per palette), which always passes.
 */
export function readableRegions(spec: Spec): { regions: Spec["regions"]; fixes: Fix[] } {
  const regions: Spec["regions"] = {};
  const fixes: Fix[] = [];
  for (const [name, style] of Object.entries(spec.regions) as [Region, NonNullable<Spec["regions"][Region]>][]) {
    const next = { ...style };
    if (style.background || style.text) {
      for (const mode of ["light", "dark"] as const) {
        const p = spec[mode];
        const bgs = fillColours(style.background, p, p[BEHIND[name] ?? "bg"]);
        const textSlot = style.text ?? DEFAULT_TEXT[name] ?? "fg";
        if (textSlot === "auto") continue;
        const t = p[textSlot];
        const min = name === "reply" || name === "user-message" || name === "composer" ? 4.5 : 3;
        if (bgs.some((bg) => contrast(t, bg) < min)) {
          next.text = "auto";
          fixes.push({ mode, what: name });
          break;
        }
      }
    }
    regions[name] = next;
  }
  return { regions, fixes };
}

/** The design with every colour made readable, and a list of what had to change. */
export function makeReadable(spec: Spec): { spec: Spec; fixes: Fix[] } {
  const light = readablePalette(spec.light, "light");
  const dark = readablePalette(spec.dark, "dark");
  const withPalettes = { ...spec, light: light.palette, dark: dark.palette };
  const regions = readableRegions(withPalettes);
  return { spec: { ...withPalettes, regions: regions.regions }, fixes: [...light.fixes, ...dark.fixes, ...regions.fixes] };
}

/** For "auto" text in a region: black or white on the region's background (or the middle of its gradient). */
export function autoText(f: Fill | undefined, p: Palette, behind: string): string {
  const colours = fillColours(f, p, behind);
  // On a gradient, pick what reads best on its worst end.
  const black = Math.min(...colours.map((c) => contrast("#0a0a0a", c)));
  const white = Math.min(...colours.map((c) => contrast("#ffffff", c)));
  return black >= white ? "#0a0a0a" : "#ffffff";
}

export { BEHIND as REGION_BEHIND };
