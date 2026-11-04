"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Runner } from "./RunCode";
import { checkWidgetEvent, widgetDocument, type Theme } from "@/lib/widgets/frame";
import { costText } from "@/lib/gadgets/cost";
import { loadGadgetData, saveGadget, saveGadgetData } from "@/app/gadgets/actions";

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

/** What gadgets still in a reply remember, for this visit only (saved gadgets keep it for good). */
const memory = new Map<string, string>();
/** Gadgets saved from a reply during this visit, so the card says so after being redrawn. */
const savedFrom = new Map<string, string>();

type Spend = { last: number; total: number; model: string };

/**
 * A gadget: a small app the model built (a ```widget:Title block), working right in the reply,
 * or full screen on its own page once saved (`gadgetId`). It runs sealed off (lib/widgets/frame.ts);
 * this card answers what it asks for: an AI's answer (cost shown each time), the AIs it can
 * offer, what it remembers, and text to offer to the chat.
 */
export function Widget({
  title,
  html,
  streaming,
  gadgetId,
  full = false,
}: {
  title: string;
  html: string;
  streaming: boolean;
  gadgetId?: string;
  full?: boolean;
}) {
  const run = useContext(Runner);
  const path = usePathname();
  const theme = useTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);
  const [error, setError] = useState<string | null>(null);
  const [offer, setOffer] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [round, setRound] = useState(0);
  const [spend, setSpend] = useState<Spend | null>(null);
  const [asking, setAsking] = useState(false);
  const [saved, setSaved] = useState<string | null>(() => savedFrom.get(html) ?? null);
  const [saving, setSaving] = useState(false);
  const doc = useMemo(() => (theme ? widgetDocument(html, theme) : null), [html, theme]);
  // One question to an AI at a time; others wait their turn.
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (streaming) return;
    const reply = (id: number, ok: boolean, value: unknown) =>
      frame.current?.contentWindow?.postMessage(ok ? { kind: "reply", id, ok, value } : { kind: "reply", id, ok, error: value }, "*");
    const listen = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const ev = checkWidgetEvent(e.data);
      if (!ev) return;
      switch (ev.kind) {
        case "height":
          setHeight(ev.value);
          return;
        case "error":
          setError(ev.text);
          return;
        case "send":
          setOffer(ev.text);
          return;
        case "models":
          fetch("/api/gadgets/ask")
            .then((r) => r.json())
            .then((b: { models?: unknown }) => reply(ev.id, true, Array.isArray(b.models) ? b.models : []))
            .catch(() => reply(ev.id, false, "Couldn't reach Depeche."));
          return;
        case "load":
          if (gadgetId) loadGadgetData(gadgetId).then((d) => reply(ev.id, true, d), () => reply(ev.id, false, "Couldn't load."));
          else reply(ev.id, true, memory.get(html) ?? null);
          return;
        case "save":
          if (gadgetId) saveGadgetData(gadgetId, ev.data).then((r) => reply(ev.id, r.ok, r.ok ? true : r.error), () => reply(ev.id, false, "Couldn't save."));
          else {
            memory.set(html, ev.data);
            reply(ev.id, true, true);
          }
          return;
        case "ask": {
          const job = queue.current.then(async () => {
            setAsking(true);
            try {
              const res = await fetch("/api/gadgets/ask", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ prompt: ev.prompt, system: ev.system, model: ev.model, gadget: gadgetId, title }),
              });
              const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string; cost?: number; model?: string };
              if (typeof body.cost === "number" && body.cost > 0) {
                const cost = body.cost;
                setSpend((s) => ({ last: cost, total: (s?.total ?? 0) + cost, model: body.model ?? s?.model ?? "" }));
              }
              if (res.ok && typeof body.text === "string") reply(ev.id, true, body.text);
              else {
                const why = body.error ?? "The AI didn't answer. Try again.";
                setError(why);
                reply(ev.id, false, why);
              }
            } catch {
              reply(ev.id, false, "Couldn't reach Depeche. Check your connection.");
            } finally {
              setAsking(false);
            }
          });
          queue.current = job.catch(() => {});
          return;
        }
      }
    };
    addEventListener("message", listen);
    return () => removeEventListener("message", listen);
  }, [streaming, gadgetId, html, title]);

  const chatId = /^\/c\/([0-9a-f-]{36})/.exec(path ?? "")?.[1] ?? null;

  return (
    <div className={full ? "flex flex-col gap-3" : "md-file flex flex-col gap-3"} data-testid="widget">
      {!full ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span aria-hidden className="md-file-icon text-[8px]!">GADGET</span>
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold">{title}</p>
              <p className="text-[13px] text-mute">Made by the AI. It runs sealed off, with no access to your account or the internet.</p>
            </div>
          </div>
          {!streaming && !gadgetId ? (
            saved ? (
              <Link href={`/gadgets/${saved}`} className="press text-[14px] underline underline-offset-4" data-testid="gadget-saved">
                Saved · Open
              </Link>
            ) : (
              <button
                type="button"
                disabled={saving}
                className="press glass glass-pill flex h-10 items-center px-4 text-[14px] font-semibold disabled:opacity-50"
                onClick={async () => {
                  setSaving(true);
                  const r = await saveGadget(title, html, chatId).catch(() => ({ ok: false as const, error: "Couldn't save the gadget. Try again." }));
                  setSaving(false);
                  if (r.ok && r.id) {
                    savedFrom.set(html, r.id);
                    setSaved(r.id);
                  } else if (!r.ok) setError(r.error);
                }}
              >
                <span>{saving ? "Saving…" : "Save to My gadgets"}</span>
              </button>
            )
          ) : null}
        </div>
      ) : null}
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
          style={{ height: full ? Math.max(height, 480) : height, maxHeight: full ? "none" : "75vh", colorScheme: theme?.dark ? "dark" : "light" }}
        />
      ) : null}
      {asking || spend ? (
        <p className="text-[13px] text-mute" role="status" data-testid="gadget-cost">
          {asking
            ? "Asking the AI…"
            : `That cost ${costText(spend!.last)}${spend!.model ? ` (${spend!.model})` : ""} · ${costText(spend!.total)} so far. It counts toward your spending.`}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-[14px] text-mute">
          {error.startsWith("Part of") ? error : `Part of this gadget didn't work: ${error}`}
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
              {run?.onSend ? "Not now" : "Close"}
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
