import { autoText, onColour, REGION_BEHIND } from "./contrast";
import { FONTS, type Fill, type Palette, type Region, type RegionStyle, type Spec } from "./spec";

/**
 * Turns a checked design into the styles that apply it. Only values from `cleanSpec` reach here
 * (colours as #rrggbb, fixed choices, numbers in range, font names from a fixed list), so nothing a
 * model or a person typed is ever written into the styles as-is.
 *
 * The screens mark their parts with `data-part="…"`, and the selectors below target those. The
 * styles come after Depeche's own, and Tailwind's utilities sit in a layer, so these win.
 */

const R = ":root:root";

/** Where each region is on the screens. */
const SELECTORS: Record<Region, string> = {
  app: "body",
  sidebar: "[data-part=sidebar]",
  "chat-header": "[data-part=chat-header]",
  "page-header": "[data-part=page-header]",
  "user-message": "[data-part=user-message]",
  reply: "[data-testid=reply]",
  composer: "[data-part=composer]",
  "send-button": "[data-part=composer] .glass",
  "main-buttons": ":root .glass",
  "chat-item": ".chat-row > a",
  "nav-pills": ":root .nav-pill",
  greeting: "[data-part=greeting]",
  shortcuts: ":root .look-shortcut",
};

/** What hiding each piece hides. */
const HIDES: Record<Spec["hide"][number], string> = {
  "keyboard-hint": "[data-part=keyboard-hint]",
  spending: "[data-part=spending]",
  "report-link": "[data-part=report-link]",
  "archived-link": "[data-part=archived-link]",
  "search-chats": "[data-part=search-chats]",
  "greeting-line": "[data-part=greeting-line]",
  "reply-model": "[data-part=reply-model]",
};

const CORNER_SCALE = { sharp: 0.2, soft: 0.6, round: 1, extra: 1.5 } as const;
const WIDTH = { narrow: "620px", normal: "760px", wide: "980px", full: "100%" } as const;

const fillCss = (f: Fill): string =>
  f === "transparent" ? "transparent" : typeof f === "string" ? `var(--${slotVar(f)})` : `linear-gradient(${f.angle}deg, var(--${slotVar(f.from)}), var(--${slotVar(f.to)}))`;

/** Palette slot names as the variables Depeche already uses (onInv is --on-inv). */
function slotVar(slot: string): string {
  return slot.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function vars(p: Palette, spec: Spec, scheme: "light" | "dark"): string {
  const out = Object.entries(p).map(([k, v]) => `--${slotVar(k)}:${v};`);
  out.push(`--on-accent:${onColour(p.accent)};`, `--on-accent2:${onColour(p.accent2)};`, `color-scheme:${scheme};`);
  // "auto" text in a region: black or white, whichever reads on that region in this palette.
  for (const [name, style] of Object.entries(spec.regions) as [Region, RegionStyle][]) {
    const behind = p[REGION_BEHIND[name] ?? "bg"];
    out.push(`--auto-${name}:${autoText(style.background, p, behind)};`);
  }
  return out.join("");
}

const SHADOW = {
  none: "none",
  soft: "0 6px 18px -8px color-mix(in srgb, var(--fg) 30%, transparent)",
  strong: "0 14px 34px -10px color-mix(in srgb, var(--fg) 45%, transparent)",
  glow: "0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent), 0 10px 28px -10px var(--accent)",
} as const;

function regionCss(name: Region, s: RegionStyle): string {
  const d: string[] = [];
  if (s.background) d.push(`background:${fillCss(s.background)}`);
  if (s.text) d.push(`color:${s.text === "auto" ? `var(--auto-${name})` : `var(--${slotVar(s.text)})`}`);
  if (s.border === "none") d.push("border-color:transparent");
  else if (s.border) d.push(`border:${s.borderWidth ?? 1}px solid var(--${slotVar(s.border)})`);
  if (typeof s.radius === "number") d.push(`border-radius:${s.radius}px`);
  if (s.shadow) d.push(`box-shadow:${SHADOW[s.shadow]}`);
  if (s.weight) d.push(`font-weight:${s.weight}`);
  if (s.uppercase !== undefined) d.push(`text-transform:${s.uppercase ? "uppercase" : "none"}`);
  if (s.italic !== undefined) d.push(`font-style:${s.italic ? "italic" : "normal"}`);
  if (typeof s.tracking === "number") d.push(`letter-spacing:${s.tracking}em`);
  if (s.font) d.push(`font-family:${FONTS[s.font].css}`);
  if (!d.length) return "";
  const sel = SELECTORS[name];
  let css = `${sel}{${d.join(";")}}`;
  // The big buttons are glass by default: a background of their own replaces the glass.
  if (s.background && (name === "send-button" || name === "main-buttons")) {
    css += `${sel}::before{display:none}${sel} .glass-lens{display:none}${sel} > *{text-shadow:none}`;
  }
  // Text inside a styled region follows it (labels, icons, links).
  if (s.text && (name === "chat-header" || name === "page-header" || name === "sidebar")) {
    css += `${sel} .text-mute{color:inherit;opacity:.75}`;
  }
  return css;
}

function backdrop(kind: Spec["backdrop"]): string | null {
  const a = (pct: number) => `color-mix(in srgb, var(--accent) ${pct}%, transparent)`;
  const b = (pct: number) => `color-mix(in srgb, var(--accent2) ${pct}%, transparent)`;
  switch (kind) {
    case "dots":
      return `radial-gradient(${a(28)} 1.3px, transparent 1.8px) 0 0 / 22px 22px`;
    case "grid":
      return `linear-gradient(var(--line) 1px, transparent 1px) 0 0 / 32px 32px, linear-gradient(90deg, var(--line) 1px, transparent 1px) 0 0 / 32px 32px`;
    case "stripes":
      return `repeating-linear-gradient(135deg, ${a(8)} 0 14px, transparent 14px 28px)`;
    case "glow":
      return `radial-gradient(60% 45% at 15% 0%, ${a(26)}, transparent 70%), radial-gradient(50% 40% at 95% 8%, ${b(24)}, transparent 70%)`;
    case "confetti":
      return [
        `radial-gradient(circle at 12% 18%, ${a(45)} 0 3px, transparent 4px)`,
        `radial-gradient(circle at 68% 32%, ${b(45)} 0 2.5px, transparent 3.5px)`,
        `radial-gradient(circle at 38% 74%, ${a(35)} 0 2px, transparent 3px)`,
        `radial-gradient(circle at 86% 82%, ${b(40)} 0 3px, transparent 4px)`,
      ]
        .map((g) => `${g} 0 0 / 140px 140px`)
        .join(", ");
    case "waves":
      return `radial-gradient(circle at 50% 100%, transparent 58%, ${a(14)} 60% 64%, transparent 66%) 0 0 / 56px 28px`;
    case "sunrise":
      return `linear-gradient(180deg, ${a(22)}, transparent 55%)`;
    default:
      return null;
  }
}

/** The styles for a design. `null` gives only what the light/dark and text-size buttons need. */
export function designCss(spec: Spec): string {
  const css: string[] = [];

  // Colours, for light and dark. A person's own light/dark button (data-scheme) beats the device.
  const light = vars(spec.light, spec, "light");
  const dark = vars(spec.dark, spec, "dark");
  if (spec.mode === "light") css.push(`${R}{${light}}`);
  else if (spec.mode === "dark") css.push(`${R}{${dark}}`);
  else css.push(`${R}{${light}}@media (prefers-color-scheme: dark){${R}{${dark}}}`);
  css.push(`${R}[data-scheme=light]{${light}}${R}[data-scheme=dark]{${dark}}`);

  // Fonts.
  css.push(`body,input,textarea,button,select{font-family:${FONTS[spec.fonts.body].css}}`);
  if (spec.fonts.headings !== spec.fonts.body) css.push(`h1,h2,h3,h4,.md h1,.md h2,.md h3,.md h4{font-family:${FONTS[spec.fonts.headings].css}}`);
  if (spec.fonts.wordmark !== "archivo") css.push(`.wordmark{font-family:${FONTS[spec.fonts.wordmark].css};font-stretch:normal}`);

  // Size of the text people read, times their own text-size button (data-text).
  css.push(`${R}{--look-scale:${spec.textScale}}`);
  const size = (px: number) => `calc(${px}px * var(--look-scale, 1) * var(--look-user, 1))`;
  css.push(
    `.md{font-size:${size(17)}}[data-part=user-message]{font-size:${size(17)}}` +
      `[data-part=composer] textarea{font-size:${size(17)};line-height:1.45}.chat-row > a{font-size:${size(16)}}`,
  );

  // Corners.
  const k = CORNER_SCALE[spec.corners];
  if (k !== 1) {
    const r = (rem: number) => `${(rem * k).toFixed(3)}rem`;
    css.push(
      `${R}{--radius-sm:${r(0.25)};--radius-md:${r(0.375)};--radius-lg:${r(0.5)};--radius-xl:${r(0.75)};--radius-2xl:${r(1)};--radius-3xl:${r(1.5)}}` +
        `[data-part=composer]{border-radius:${Math.round(26 * k)}px}[data-part=user-message]{border-radius:${Math.round(22 * k)}px}`,
    );
    if (spec.corners === "sharp") css.push(`:root .glass-pill,:root .nav-pill,:root .look-shortcut{border-radius:6px}:root .glass-lens{clip-path:inset(0 round 6px)}`);
  }

  // The big buttons.
  if (spec.buttons !== "glass") {
    const look = {
      solid: "background:var(--accent);color:var(--on-accent);box-shadow:none",
      outline: "background:transparent;color:var(--fg);box-shadow:none;border:1.5px solid var(--fg)",
      soft: "background:var(--soft);color:var(--fg);box-shadow:none",
    }[spec.buttons];
    css.push(`:root .glass{${look}}:root .glass::before{display:none}:root .glass-lens{display:none}:root .glass-pill > *{text-shadow:none}`);
  } else if (!spec.effects.buttonPattern) css.push(`:root .glass-lens{display:none}`);

  // Effects.
  if (!spec.effects.pressFlash) css.push(`:root .press[data-pressed]{animation:press-dip 200ms ease-out}`);
  if (spec.effects.cursor === "block") css.push(`:root .stream-cursor{animation:look-blink 1s steps(1,end) infinite}`);
  if (spec.effects.cursor === "dot") css.push(`:root .stream-cursor{width:.6em;height:.6em;border-radius:50%;vertical-align:0;background:var(--accent);animation:look-pulse 1s ease-in-out infinite}`);
  if (spec.effects.cursor === "bar") css.push(`:root .stream-cursor{width:2px;background:var(--accent);animation:look-blink 1s steps(1,end) infinite}`);
  if (spec.effects.cursor !== "glitch") {
    css.push(`@keyframes look-blink{50%{opacity:0}}@keyframes look-pulse{50%{transform:scale(.6);opacity:.5}}@media (prefers-reduced-motion: reduce){:root .stream-cursor{animation:none}}`);
  }

  // Background pattern.
  const pattern = backdrop(spec.backdrop);
  const appFill = spec.regions.app?.background;
  if (pattern) css.push(`body{background:${pattern}, ${appFill ? fillCss(appFill) : "var(--bg)"};background-attachment:fixed}`);

  // Layout.
  if (spec.layout.sidebarDesktop === "right") {
    css.push(`@media (min-width: 768px){[data-part=app]{flex-direction:row-reverse}[data-part=sidebar-desktop]{border-right-width:0;border-left:1px solid var(--line)}}`);
  }
  if (spec.layout.sidebarPhone === "right") {
    css.push(`[data-part=drawer]{left:auto;right:0}[data-part=menu-button]{order:10}`);
  }
  if (spec.layout.myMessages === "left") css.push(`[data-part=user-row]{align-items:flex-start}`);
  if (spec.chatWidth !== "normal") css.push(`[data-part=thread],[data-part=composer-wrap]{max-width:${WIDTH[spec.chatWidth]}}`);

  // Regions (the app's background goes with the pattern above, when there is one).
  for (const [name, style] of Object.entries(spec.regions) as [Region, RegionStyle][]) {
    if (name === "app" && pattern) {
      const { background: _bg, ...rest } = style;
      css.push(regionCss(name, rest));
    } else css.push(regionCss(name, style));
  }

  // Hidden pieces.
  if (spec.hide.length) css.push(`${spec.hide.map((h) => HIDES[h]).join(",")}{display:none!important}`);

  return css.filter(Boolean).join("\n");
}

/** Styles the light/dark and text-size buttons need even with the standard look. */
export const BASE_LOOK_CSS = `:root[data-text=bigger]{--look-user:1.15}:root[data-text=biggest]{--look-user:1.3}:root[data-text=smaller]{--look-user:.9}`;
