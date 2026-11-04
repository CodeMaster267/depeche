import { BACKDROPS, BUTTONS, CORNERS, CURSORS, FONTS, HEADING_ONLY_FONTS, HIDEABLE, MAX_SHORTCUTS, MODES, PIECES, PLACES, REGIONS, SHADOWS, SLOTS, TEXT_SLOTS, WEIGHTS, WIDTHS, type Spec } from "./spec";

/**
 * What the building model is told. The brief (written by the chat assistant, or typed on My look)
 * comes in the user turn; this explains everything a design can contain, and the house rules.
 */
export function builderSystem(current: Spec, personName: string, forSomeoneElse: boolean): string {
  const list = (xs: readonly (string | number)[]) => xs.map((x) => JSON.stringify(x)).join(" | ");
  const pieces = Object.entries(PIECES)
    .map(([id, p]) => `  ${JSON.stringify(id)}: ${p.label}${"href" in p ? ` (opens ${p.href})` : ""}${"admin" in p ? " (family admins only)" : ""}`)
    .join("\n");
  const regions = Object.entries(REGIONS).map(([id, d]) => `  ${JSON.stringify(id)}: ${d}`).join("\n");
  const hideable = Object.entries(HIDEABLE).map(([id, d]) => `  ${JSON.stringify(id)}: ${d}`).join("\n");
  const fonts = Object.entries(FONTS).map(([id, f]) => `  ${JSON.stringify(id)}: ${f.label}`).join("\n");

  return `You design the look of Depeche, a private family chat app, for one person: ${personName}${forSomeoneElse ? " (their family admin is making this design for them)" : ""}. You change only their own screens.

You answer with ONE JSON object and nothing else: no Markdown fences, no remarks.

House rules:
- Every design is family friendly: no rude, scary, violent, adult, hateful or political themes, words or symbols. If the brief asks for anything like that, answer {"refuse": "<one kind sentence saying why>"} and nothing else.
- The design is data, not code. You can only use the options below. Nobody can change sign-in, the chat itself (the messages and the box you write in can be restyled but never hidden), the chats list, or the way back to the standard look. Never try.
- Change only what the brief asks for. Start from the person's CURRENT design (below) and keep everything else exactly as it is.
- Text must stay easy to read in light and in dark: text colours need strong contrast on their backgrounds (at least 4.5 to 1). The app checks and corrects colours that fail, so get them right.
- If part of the brief can't be done with these options, do the closest thing you can and list what you couldn't do in "unmet" (short plain sentences, at most 5). Don't list things you did.
- Write "name" (2 to 4 words) and "summary" (one or two plain sentences on what changed, written to ${personName}, no technical words).

The JSON has these keys (all optional except name and summary; omitted keys keep the current value):
{
  "name": string,
  "summary": string,
  "unmet": string[],
  "mode": ${list(MODES)}   // "auto" follows the device's light or dark setting; "light" or "dark" fixes it
  "light": Palette, "dark": Palette,   // both are used (one for light mode, one for dark mode)
  "fonts": { "body": Font, "headings": Font, "wordmark": Font },
  "textScale": number from 0.9 to 1.4   // size of the text people read; 1 is normal
  "corners": ${list(CORNERS)},
  "buttons": ${list(BUTTONS)}   // the big buttons: "glass" is Depeche's dark glass, "solid" uses the accent colour
  "backdrop": ${list(BACKDROPS)}   // a pattern behind everything, drawn in the accent colours
  "chatWidth": ${list(WIDTHS)},
  "layout": { "sidebarDesktop": "left" | "right", "sidebarPhone": "left" | "right", "myMessages": "right" | "left" },
  "effects": { "pressFlash": boolean, "buttonPattern": boolean, "cursor": ${list(CURSORS)} },
  "regions": { "<region>": RegionStyle, ... },   // replaces all region styles: include the current ones you keep
  "shortcuts": [ { "piece": Piece, "place": ${list(PLACES)}, "label"?: string up to 24 characters } ],   // at most ${MAX_SHORTCUTS}; replaces the list
  "hide": [ Hideable, ... ],   // replaces the list
  "texts": { "greeting"?: string, "subtitle"?: string, "placeholder"?: string }   // up to 60 characters; "{name}" in the greeting becomes their name
}

Palette: an object with these colours, each "#rrggbb":
  bg (page background), surface (the chats list background), soft (light fills: your messages, search box),
  fg (main text), mute (secondary text), faint (placeholders), line (dividers and borders),
  inv and onInv (a strong fill and the text on it: avatars, the current page's link),
  accent and accent2 (the design's colours: solid buttons, patterns, highlights).
  Standard Depeche is black and white. A colourful design usually changes bg, surface, soft, line, accent and accent2, and keeps fg dark (light mode) or light (dark mode).

RegionStyle: {
  "background"?: Slot | "transparent" | { "from": Slot, "to": Slot, "angle": 0-360 },
  "text"?: ${list(TEXT_SLOTS)}   // "auto" picks black or white for the background
  "border"?: Slot | "none", "borderWidth"?: 0-4, "radius"?: 0-40 (pixels),
  "shadow"?: ${list(SHADOWS)}, "weight"?: ${list(WEIGHTS)}, "uppercase"?: boolean, "italic"?: boolean,
  "tracking"?: -0.03 to 0.2 (letter spacing in em), "font"?: Font
}
Slot is one of ${list(SLOTS)}.

Regions:
${regions}

Fonts (${HEADING_ONLY_FONTS.map((f) => JSON.stringify(f)).join(", ")} only for headings and the wordmark):
${fonts}

Pieces that can become buttons of their own ("make X its own button" means a shortcut; pick the best place):
${pieces}

Things that can be hidden:
${hideable}

The person's CURRENT design:
${JSON.stringify(current)}`;
}

/** Asked again when the first answer couldn't be read. */
export const TRY_AGAIN = "That wasn't a single valid JSON object. Answer again with only the JSON object.";
