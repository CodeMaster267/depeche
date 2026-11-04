/**
 * Gadgets: small interactive apps a model builds in a reply (a ```widget:Title block holding an HTML page):
 * calculators, quizzes, games, sliders that explain something, small dashboards.
 *
 * Model output is never run in the app's own page (CLAUDE.md). A widget runs in an iframe with
 * `sandbox="allow-scripts"` and no `allow-same-origin`, so it gets an opaque origin of its own: it
 * can't see the page, cookies, storage or the session, can't call our API as the person, can't
 * open windows, show dialogs, submit forms or navigate the app. Its content security policy
 * (first thing in the document, so it covers everything after it) blocks every network request
 * and every outside script, style, font and picture, so it can't load anything or send what
 * someone types anywhere. All it can do is post plain messages to the page, which checks them:
 * its height, an error, or text to offer back to the chat (the person still taps Send).
 */

export const MAX_WIDGET = 150_000;
export const MAX_SEND = 4_000;
export const MAX_HEIGHT = 2_000;

/** "widget:Tip-calculator" → "Tip calculator"; null for any other block. */
export function widgetFromLang(lang: string | undefined): string | null {
  if (!lang) return null;
  const m = /^widget(?::(.*))?$/i.exec(lang);
  if (!m) return null;
  const title = (m[1] ?? "").replace(/[-_]+/g, " ").replace(/[^\p{L}\p{N} '&.,!?()]/gu, "").trim().slice(0, 60);
  return title || "Gadget";
}

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** Runs first in the widget: reports its height and errors, and gives it depeche.send(). */
const BRIDGE = `(() => {
  const post = (m) => parent.postMessage(m, "*");
  window.depeche = Object.freeze({ send: (t) => post({ kind: "send", text: String(t) }) });
  let last = 0;
  const size = () => {
    const h = Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0));
    if (h !== last) { last = h; post({ kind: "height", value: h }); }
  };
  new ResizeObserver(size).observe(document.documentElement);
  addEventListener("load", () => { if (document.body) new ResizeObserver(size).observe(document.body); size(); });
  addEventListener("error", (e) => post({ kind: "error", text: String(e.message || "Something in this gadget went wrong.") }));
  addEventListener("unhandledrejection", (e) => post({ kind: "error", text: String((e.reason && e.reason.message) || e.reason || "Something in this gadget went wrong.") }));
})();`;

export type Theme = { dark: boolean; fg: string; bg: string; mute: string; line: string; font: string };

/** A CSS colour or font list from the page, kept only if it can't break out of the style. */
const safe = (v: string, fallback: string) => (/^[\w\s#(),.%'"-]{1,200}$/.test(v.trim()) && !/[<>;{}\\]/.test(v) ? v.trim() : fallback);

/** The document the frame shows: our policy and bridge first, then the model's page. */
export function widgetDocument(html: string, theme: Theme): string {
  const fg = safe(theme.fg, theme.dark ? "#fff" : "#000");
  const bg = safe(theme.bg, theme.dark ? "#000" : "#fff");
  const style = [
    `:root{color-scheme:${theme.dark ? "dark" : "light"};--depeche-fg:${fg};--depeche-bg:${bg};--depeche-mute:${safe(theme.mute, "#777")};--depeche-line:${safe(theme.line, "#ccc")};--depeche-font:${safe(theme.font, "system-ui, sans-serif")}}`,
    "html{background:transparent}",
    "body{margin:0;padding:16px;color:var(--depeche-fg);font:16px/1.5 var(--depeche-font);overflow-wrap:anywhere}",
    "*,*::before,*::after{box-sizing:border-box}",
    "button,input,select,textarea{font:inherit;color:inherit}",
    "img,svg,canvas,video{max-width:100%}",
  ].join("");
  return [
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>${style}</style>`,
    `<script>${BRIDGE}</script>`,
    html.slice(0, MAX_WIDGET),
  ].join("\n");
}

export type WidgetEvent = { kind: "height"; value: number } | { kind: "error"; text: string } | { kind: "send"; text: string };

/** Checks something a widget posted before the page uses it. */
export function checkWidgetEvent(raw: unknown): WidgetEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const { kind, value, text } = raw as { kind?: unknown; value?: unknown; text?: unknown };
  if (kind === "height" && typeof value === "number" && Number.isFinite(value)) return { kind, value: Math.max(40, Math.min(MAX_HEIGHT, Math.round(value))) };
  if ((kind === "error" || kind === "send") && typeof text === "string") {
    // Control and direction characters can't sneak in; the text is shown and sent as plain text.
    const clean = text.replace(/[\u0000-\u0008\u000B-\u001F\u007F‎‏‪-‮⁦-⁩]/g, "").trim();
    if (!clean) return null;
    return { kind, text: clean.slice(0, kind === "send" ? MAX_SEND : 300) };
  }
  return null;
}
