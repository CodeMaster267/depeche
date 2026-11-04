/**
 * A person's design ("My look"): a checked description of how their Depeche looks and is laid
 * out. It is data, never code. A bigger model writes it from a brief, `cleanSpec` keeps only what
 * is allowed here, `lib/design/contrast.ts` makes sure text stays readable, and `lib/design/css.ts`
 * turns it into styles. Everything the model may change is listed in this file, so the protected
 * core (sign-in, the chat itself, the way back to the standard look) can't be touched.
 */

export const SLOTS = ["bg", "surface", "soft", "fg", "mute", "faint", "line", "inv", "onInv", "accent", "accent2"] as const;
export type Slot = (typeof SLOTS)[number];
export type Palette = Record<Slot, string>;

/** Colours a region's text may use: a palette colour, or "auto" (black or white, whichever reads best). */
export const TEXT_SLOTS = ["fg", "mute", "onInv", "accent", "auto"] as const;
export type TextSlot = (typeof TEXT_SLOTS)[number];

export const FONTS = {
  geist: { label: "Geist (Depeche's own)", css: "var(--font-geist), system-ui, sans-serif" },
  device: { label: "The device's own", css: "system-ui, -apple-system, 'Segoe UI', sans-serif" },
  rounded: { label: "Rounded", css: "ui-rounded, var(--font-nunito), system-ui, sans-serif" },
  nunito: { label: "Nunito (soft, friendly)", css: "var(--font-nunito), ui-rounded, system-ui, sans-serif" },
  baloo: { label: "Baloo (bubbly)", css: "var(--font-baloo), ui-rounded, system-ui, sans-serif" },
  comic: { label: "Comic Neue (handwritten, playful)", css: "var(--font-comic), 'Comic Sans MS', ui-rounded, sans-serif" },
  atkinson: { label: "Atkinson Hyperlegible (easiest to read)", css: "var(--font-atkinson), system-ui, sans-serif" },
  grotesk: { label: "Space Grotesk (techy)", css: "var(--font-grotesk), system-ui, sans-serif" },
  archivo: { label: "Archivo (wide and bold)", css: "var(--font-archivo), system-ui, sans-serif" },
  serif: { label: "Classic serif", css: "ui-serif, Georgia, 'Times New Roman', serif" },
  lora: { label: "Lora (book serif)", css: "var(--font-lora), ui-serif, Georgia, serif" },
  fraunces: { label: "Fraunces (warm, old-style)", css: "var(--font-fraunces), ui-serif, Georgia, serif" },
  playfair: { label: "Playfair Display (elegant)", css: "var(--font-playfair), ui-serif, Georgia, serif" },
  caveat: { label: "Caveat (handwriting, headings only)", css: "var(--font-caveat), cursive" },
  mono: { label: "Typewriter (monospace)", css: "var(--font-geist-mono), ui-monospace, monospace" },
} as const;
export type FontId = keyof typeof FONTS;
/** Too hard to read for long text: used for headings and the wordmark only. */
export const HEADING_ONLY_FONTS: FontId[] = ["caveat"];

/**
 * Pieces of Depeche that can become buttons of their own. Links go to a page (or the exact setting
 * on it); actions work on the chat screen.
 */
export const PIECES = {
  "new-chat": { label: "New chat", kind: "action" },
  chats: { label: "Chats", kind: "action" },
  "choose-model": { label: "Model", kind: "action" },
  "voice-chat": { label: "Voice chat", kind: "action" },
  "web-search": { label: "Web search", kind: "action" },
  attach: { label: "Attach", kind: "action" },
  "light-dark": { label: "Light or dark", kind: "local" },
  "text-size": { label: "Text size", kind: "local" },
  memory: { label: "Memory", kind: "link", href: "/memory" },
  instructions: { label: "My instructions", kind: "link", href: "/memory#personal-instructions" },
  account: { label: "Account", kind: "link", href: "/account" },
  family: { label: "Family", kind: "link", href: "/family", admin: true },
  "my-look": { label: "My look", kind: "link", href: "/design" },
  "keep-chats": { label: "Keep my chats", kind: "link", href: "/account#old-chats" },
  "share-titles": { label: "Privacy", kind: "link", href: "/account#privacy" },
  password: { label: "Password", kind: "link", href: "/account#password" },
  export: { label: "Download my data", kind: "link", href: "/account#your-data" },
  import: { label: "Bring in old chats", kind: "link", href: "/account#bring-in-old-chats" },
  "sign-out-everywhere": { label: "Sign out everywhere", kind: "link", href: "/account#devices" },
  report: { label: "Report a bug", kind: "link", href: "/report" },
} as const satisfies Record<string, { label: string; kind: "action" | "link" | "local"; href?: string; admin?: boolean }>;
export type PieceId = keyof typeof PIECES;

export const PLACES = ["header", "composer", "sidebar"] as const;
export type Place = (typeof PLACES)[number];

/** Things a person may hide. The chat, the box to write in, your chats and the way back can't be. */
export const HIDEABLE = {
  "keyboard-hint": "The 'Enter to send' line under the box",
  spending: "The spending bar in the chats list",
  "report-link": "The 'Report a bug' link in the chats list",
  "archived-link": "The 'Archived chats' button",
  "search-chats": "The search box above your chats",
  "greeting-line": "The 'What's on your mind?' line on a new chat",
  "reply-model": "The model name and cost under each reply",
} as const;
export type Hideable = keyof typeof HIDEABLE;

/** Parts of the screen that can be restyled. */
export const REGIONS = {
  app: "The whole background behind everything",
  sidebar: "The chats list (on the side on computers, the drawer on phones)",
  "chat-header": "The bar at the top of a chat",
  "page-header": "The bar at the top of Account, Memory and other pages",
  "user-message": "Your own messages",
  reply: "Depeche's replies",
  composer: "The box you write in",
  "send-button": "The send, stop and voice buttons",
  "main-buttons": "The big buttons (New chat, Save and so on)",
  "chat-item": "Each chat in the chats list",
  "nav-pills": "The page links (Memory, Account, Family)",
  greeting: "The 'Hi' greeting on a new chat",
  shortcuts: "Buttons added with this design",
} as const;
export type Region = keyof typeof REGIONS;

export type Fill = Slot | "transparent" | { from: Slot; to: Slot; angle: number };
export type RegionStyle = {
  background?: Fill;
  text?: TextSlot;
  border?: Slot | "none";
  borderWidth?: number;
  radius?: number;
  shadow?: "none" | "soft" | "strong" | "glow";
  weight?: 400 | 500 | 600 | 700 | 800;
  uppercase?: boolean;
  tracking?: number;
  font?: FontId;
  italic?: boolean;
};
export const SHADOWS = ["none", "soft", "strong", "glow"] as const;
export const WEIGHTS = [400, 500, 600, 700, 800] as const;

export const BACKDROPS = ["plain", "dots", "grid", "stripes", "glow", "confetti", "waves", "sunrise"] as const;
export const BUTTONS = ["glass", "solid", "outline", "soft"] as const;
export const CORNERS = ["sharp", "soft", "round", "extra"] as const;
export const WIDTHS = ["narrow", "normal", "wide", "full"] as const;
export const MODES = ["auto", "light", "dark"] as const;
export const CURSORS = ["glitch", "block", "dot", "bar"] as const;

export type Shortcut = { piece: PieceId; place: Place; label?: string };

export type Spec = {
  v: 1;
  /** A short name for this look, like "Sunny playground". */
  name: string;
  /** One or two sentences on what this look changes, shown with Keep or Undo. */
  summary: string;
  mode: (typeof MODES)[number];
  light: Palette;
  dark: Palette;
  fonts: { body: FontId; headings: FontId; wordmark: FontId };
  /** Size of the text people read (replies, messages, the box, the chats list): 0.9 to 1.4. */
  textScale: number;
  corners: (typeof CORNERS)[number];
  buttons: (typeof BUTTONS)[number];
  backdrop: (typeof BACKDROPS)[number];
  chatWidth: (typeof WIDTHS)[number];
  layout: {
    /** Which side the chats list is on, on a computer and on a phone. */
    sidebarDesktop: "left" | "right";
    sidebarPhone: "left" | "right";
    /** Which side your own messages sit on. */
    myMessages: "right" | "left";
  };
  effects: {
    /** The glitch flash when a button is tapped. */
    pressFlash: boolean;
    /** The faint code pattern inside the big buttons. */
    buttonPattern: boolean;
    /** What shows while a reply is being written. */
    cursor: (typeof CURSORS)[number];
  };
  regions: Partial<Record<Region, RegionStyle>>;
  shortcuts: Shortcut[];
  hide: Hideable[];
  texts: {
    /** The greeting on a new chat; "{name}" becomes the person's name. */
    greeting?: string;
    /** The line under the greeting. */
    subtitle?: string;
    /** Placeholder in the box you write in. */
    placeholder?: string;
  };
};

export const DEFAULT_LIGHT: Palette = {
  bg: "#ffffff", surface: "#ffffff", soft: "#f5f5f5", fg: "#0a0a0a", mute: "#707070", faint: "#a3a3a3",
  line: "#e8e8e8", inv: "#0a0a0a", onInv: "#ffffff", accent: "#0a0a0a", accent2: "#707070",
};
export const DEFAULT_DARK: Palette = {
  bg: "#000000", surface: "#000000", soft: "#0e0e0e", fg: "#f2f2f2", mute: "#8c8c8c", faint: "#555555",
  line: "#1f1f1f", inv: "#f2f2f2", onInv: "#000000", accent: "#f2f2f2", accent2: "#8c8c8c",
};

/** Depeche as it ships: strict black and white. */
export const DEFAULT_SPEC: Spec = {
  v: 1,
  name: "Standard Depeche",
  summary: "Black and white, as Depeche comes.",
  mode: "auto",
  light: DEFAULT_LIGHT,
  dark: DEFAULT_DARK,
  fonts: { body: "geist", headings: "geist", wordmark: "archivo" },
  textScale: 1,
  corners: "round",
  buttons: "glass",
  backdrop: "plain",
  chatWidth: "normal",
  layout: { sidebarDesktop: "left", sidebarPhone: "left", myMessages: "right" },
  effects: { pressFlash: true, buttonPattern: true, cursor: "glitch" },
  regions: {},
  shortcuts: [],
  hide: [],
  texts: {},
};

export const MAX_SHORTCUTS = 8;
export const MAX_TEXT = 60;
export const MAX_LABEL = 24;

const HEX = /^#[0-9a-f]{6}$/i;
const SHORT_HEX = /^#[0-9a-f]{3}$/i;

/** "#ABC" or "#AABBCC" as "#aabbcc", or null. */
export function hex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (HEX.test(s)) return s.toLowerCase();
  if (SHORT_HEX.test(s)) return `#${[...s.slice(1)].map((c) => c + c).join("")}`.toLowerCase();
  return null;
}

const oneOf = <T extends string | number>(list: readonly T[], v: unknown, fallback: T): T =>
  list.includes(v as T) ? (v as T) : fallback;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

/** Plain text a person will read: one line, no markup, no control characters, limited length. */
export function cleanText(v: unknown, max = MAX_TEXT): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/[<>`\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return s || undefined;
}

function palette(v: unknown, base: Palette): Palette {
  const out = { ...base };
  if (!isObj(v)) return out;
  for (const k of SLOTS) {
    const c = hex(v[k]);
    if (c) out[k] = c;
  }
  return out;
}

function fill(v: unknown): Fill | undefined {
  if (v === "transparent") return "transparent";
  if (typeof v === "string" && (SLOTS as readonly string[]).includes(v)) return v as Slot;
  if (isObj(v) && SLOTS.includes(v.from as Slot) && SLOTS.includes(v.to as Slot)) {
    return { from: v.from as Slot, to: v.to as Slot, angle: Math.round(num(v.angle, 0, 360, 135)) };
  }
  return undefined;
}

function regionStyle(v: unknown): RegionStyle | undefined {
  if (!isObj(v)) return undefined;
  const r: RegionStyle = {};
  const bg = fill(v.background);
  if (bg) r.background = bg;
  if (TEXT_SLOTS.includes(v.text as TextSlot)) r.text = v.text as TextSlot;
  if (v.border === "none" || SLOTS.includes(v.border as Slot)) r.border = v.border as Slot | "none";
  if (typeof v.borderWidth === "number") r.borderWidth = Math.round(num(v.borderWidth, 0, 4, 1));
  if (typeof v.radius === "number") r.radius = Math.round(num(v.radius, 0, 40, 16));
  if (SHADOWS.includes(v.shadow as never)) r.shadow = v.shadow as RegionStyle["shadow"];
  if (WEIGHTS.includes(v.weight as never)) r.weight = v.weight as RegionStyle["weight"];
  if (typeof v.uppercase === "boolean") r.uppercase = v.uppercase;
  if (typeof v.italic === "boolean") r.italic = v.italic;
  if (typeof v.tracking === "number") r.tracking = Math.round(num(v.tracking, -0.03, 0.2, 0) * 1000) / 1000;
  if (typeof v.font === "string" && v.font in FONTS) r.font = v.font as FontId;
  return Object.keys(r).length ? r : undefined;
}

const font = (v: unknown, fallback: FontId, headings = false): FontId =>
  typeof v === "string" && v in FONTS && (headings || !HEADING_ONLY_FONTS.includes(v as FontId)) ? (v as FontId) : fallback;

/**
 * Keeps only what a design may contain, on top of `base` (the person's current design): anything
 * missing or not allowed is left as it was. Never throws.
 */
export function cleanSpec(raw: unknown, base: Spec = DEFAULT_SPEC): Spec {
  const v = isObj(raw) ? raw : {};
  const fonts = isObj(v.fonts) ? v.fonts : {};
  const layout = isObj(v.layout) ? v.layout : {};
  const effects = isObj(v.effects) ? v.effects : {};
  const texts = isObj(v.texts) ? v.texts : {};

  const regions: Spec["regions"] = {};
  const rawRegions = isObj(v.regions) ? v.regions : base.regions;
  for (const k of Object.keys(REGIONS) as Region[]) {
    const r = regionStyle((rawRegions as Record<string, unknown>)[k]);
    if (r) regions[k] = r;
  }

  const shortcuts: Shortcut[] = [];
  for (const s of Array.isArray(v.shortcuts) ? v.shortcuts : base.shortcuts) {
    if (!isObj(s) || typeof s.piece !== "string" || !(s.piece in PIECES)) continue;
    const place = oneOf(PLACES, s.place, "header");
    if (shortcuts.some((x) => x.piece === s.piece && x.place === place)) continue;
    const label = cleanText(s.label, MAX_LABEL);
    shortcuts.push({ piece: s.piece as PieceId, place, ...(label ? { label } : {}) });
    if (shortcuts.length >= MAX_SHORTCUTS) break;
  }

  const hide = (Array.isArray(v.hide) ? v.hide : base.hide).filter(
    (h, i, all): h is Hideable => typeof h === "string" && h in HIDEABLE && all.indexOf(h) === i,
  );

  const greeting = "greeting" in texts ? cleanText(texts.greeting) : base.texts.greeting;
  const subtitle = "subtitle" in texts ? cleanText(texts.subtitle, 120) : base.texts.subtitle;
  const placeholder = "placeholder" in texts ? cleanText(texts.placeholder) : base.texts.placeholder;

  return {
    v: 1,
    name: cleanText(v.name, 40) ?? base.name,
    summary: cleanText(v.summary, 240) ?? base.summary,
    mode: oneOf(MODES, v.mode, base.mode),
    light: palette(v.light, base.light),
    dark: palette(v.dark, base.dark),
    fonts: {
      body: font(fonts.body, base.fonts.body),
      headings: font(fonts.headings, base.fonts.headings, true),
      wordmark: font(fonts.wordmark, base.fonts.wordmark, true),
    },
    textScale: Math.round(num(v.textScale, 0.9, 1.4, base.textScale) * 100) / 100,
    corners: oneOf(CORNERS, v.corners, base.corners),
    buttons: oneOf(BUTTONS, v.buttons, base.buttons),
    backdrop: oneOf(BACKDROPS, v.backdrop, base.backdrop),
    chatWidth: oneOf(WIDTHS, v.chatWidth, base.chatWidth),
    layout: {
      sidebarDesktop: oneOf(["left", "right"] as const, layout.sidebarDesktop, base.layout.sidebarDesktop),
      sidebarPhone: oneOf(["left", "right"] as const, layout.sidebarPhone, base.layout.sidebarPhone),
      myMessages: oneOf(["right", "left"] as const, layout.myMessages, base.layout.myMessages),
    },
    effects: {
      pressFlash: typeof effects.pressFlash === "boolean" ? effects.pressFlash : base.effects.pressFlash,
      buttonPattern: typeof effects.buttonPattern === "boolean" ? effects.buttonPattern : base.effects.buttonPattern,
      cursor: oneOf(CURSORS, effects.cursor, base.effects.cursor),
    },
    regions,
    shortcuts,
    hide,
    texts: {
      ...(greeting ? { greeting } : {}),
      ...(subtitle ? { subtitle } : {}),
      ...(placeholder ? { placeholder } : {}),
    },
  };
}

/** Every piece of text in a design that people will read, for the family-friendly check. */
export function textsOf(spec: Spec): string[] {
  return [spec.name, spec.summary, spec.texts.greeting, spec.texts.subtitle, spec.texts.placeholder, ...spec.shortcuts.map((s) => s.label)].filter(
    (t): t is string => !!t,
  );
}
