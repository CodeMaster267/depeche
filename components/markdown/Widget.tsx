"use client";

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Runner } from "./RunCode";
import { checkWidgetEvent, widgetDocument, type Theme } from "@/lib/widgets/frame";

/** The page's colours and font, so a gadget can match the look (including a personal look). */
function readTheme(): Theme {
  const root = getComputedStyle(document.documentElement);
  const body = getComputedStyle(document.body);
  const v = (name: string) => root.getPropertyValue(name).trim();
  const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(body.backgroundColor);
  const light = rgb ? (0.299 * +rgb[1] + 0.587 * +rgb[2] + 0.114 * +rgb[3]) / 255 > 0.5 : !matchMedia("(prefers-color-scheme: dark)").matches;
  return { dark: !light, fg: v("--fg") || body.color, bg: v("--bg") || body.backgroundColor, mute: v("--mute"), line: v("--line"), font: body.fontFamily };
}

function useTheme(): Theme | null {
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => {
    const update = () =>
      setTheme((old) => {
        const next = readTheme();
        return old && JSON.stringify(old) === JSON.stringify(next) ? old : next;
      });
    update();
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    // Light or dark on this device, and personal looks, change attributes and styles on <html>.
    const watch = new MutationObserver(update);
    watch.observe(document.documentElement, { attributes: true });
    watch.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      media.removeEventListener("change", update);
      watch.disconnect();
    };
  }, []);
  return theme;
}

/** A ```widget:Title block: a gadget (small app) the model built, working right in the reply. */
export function Widget({ title, html, streaming }: { title: string; html: string; streaming: boolean }) {
  const run = useContext(Runner);
  const theme = useTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);
  const [error, setError] = useState<string | null>(null);
  const [offer, setOffer] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [round, setRound] = useState(0);
  const doc = useMemo(() => (theme ? widgetDocument(html, theme) : null), [html, theme]);

  useEffect(() => {
    if (streaming) return;
    const listen = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const ev = checkWidgetEvent(e.data);
      if (!ev) return;
      if (ev.kind === "height") setHeight(ev.value);
      else if (ev.kind === "error") setError(ev.text);
      else setOffer(ev.text);
    };
    addEventListener("message", listen);
    return () => removeEventListener("message", listen);
  }, [streaming]);

  return (
    <div className="md-file flex flex-col gap-3" data-testid="widget">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden className="md-file-icon text-[8px]!">GADGET</span>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold">{title}</p>
            <p className="text-[13px] text-mute">Made by the AI. It runs sealed off, with no access to your account or the internet.</p>
          </div>
        </div>
      </div>
      {streaming ? (
        <p className="text-[14px] text-mute">Building…</p>
      ) : doc ? (
        <iframe
          key={round}
          ref={frame}
          title={title}
          // allow-scripts without allow-same-origin: an opaque origin, cut off from the app.
          sandbox="allow-scripts"
          allow=""
          referrerPolicy="no-referrer"
          srcDoc={doc}
          className="w-full rounded-xl border border-line bg-transparent"
          style={{ height, maxHeight: "75vh", colorScheme: theme?.dark ? "dark" : "light" }}
        />
      ) : null}
      {error ? (
        <p role="alert" className="text-[14px] text-mute">
          Part of this gadget didn&apos;t work: {error}
        </p>
      ) : null}
      {offer ? (
        <div className="flex flex-col gap-2 rounded-xl bg-soft px-3 py-2.5" data-testid="widget-offer">
          <p className="text-[13px] text-mute">The gadget wants to send this to the chat:</p>
          <p className="whitespace-pre-wrap text-[15px]">{offer}</p>
          <div className="flex gap-2">
            {run?.onSend ? (
              <button
                type="button"
                className="press h-9 rounded-full bg-inv px-4 text-[14px] font-medium text-on-inv"
                onClick={() => {
                  run.onSend?.(offer);
                  setOffer(null);
                }}
              >
                Send
              </button>
            ) : null}
            <button type="button" className="press h-9 rounded-full border border-line px-4 text-[14px]" onClick={() => setOffer(null)}>
              Not now
            </button>
          </div>
        </div>
      ) : null}
      {!streaming ? (
        <div className="flex flex-wrap gap-4 text-[13px] text-mute">
          <button
            type="button"
            className="press underline underline-offset-4"
            onClick={() => {
              setError(null);
              setOffer(null);
              setRound((r) => r + 1);
            }}
          >
            Start over
          </button>
          <button type="button" className="press underline underline-offset-4" aria-expanded={showCode} onClick={() => setShowCode(!showCode)}>
            {showCode ? "Hide how it's made" : "See how it's made"}
          </button>
        </div>
      ) : null}
      {showCode ? (
        <pre className="max-h-[320px] overflow-auto rounded-xl bg-soft p-3 text-[12px] leading-5" data-testid="widget-code">
          {html}
        </pre>
      ) : null}
    </div>
  );
}
