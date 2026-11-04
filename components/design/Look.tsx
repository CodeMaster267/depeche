"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { BASE_LOOK_CSS, designCss } from "@/lib/design/css";
import { PIECES, type Place, type Spec } from "@/lib/design/spec";
import { keepDesign, undoDesign } from "@/app/design/actions";

/**
 * A person's look in the browser: the design in use, and one being previewed with Keep or Undo.
 * One shared store, so the chat screen, the design brief cards in replies, My look and the extra
 * buttons all see the same look as people move between pages.
 */

export type Preview = {
  id: string;
  spec: Spec;
  /** own: just built. offered: made by their admin. history: an older one tried again. for: an admin's preview of someone else's. */
  kind: "own" | "offered" | "history" | "for";
  by?: string;
  forName?: string;
  unmet?: string[];
  adjusted?: boolean;
};
type State = {
  saved: { id: string; spec: Spec } | null;
  preview: Preview | null;
  safe: boolean;
  enabled: boolean;
  scheme: "auto" | "light" | "dark";
  text: "normal" | "bigger" | "biggest" | "smaller";
};

const BLANK: State = { saved: null, preview: null, safe: false, enabled: true, scheme: "auto", text: "normal" };
type Seed = { current: { id: string; spec: Spec } | null; offered: { id: string; spec: Spec; by: string } | null; safe: boolean; enabled: boolean };

// The browser's copy. On the server each request renders from its own seed (the context below), so
// one person's look can never reach another's page.
let state: State = BLANK;
let booted = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  emit();
}

const SeedContext = createContext<State>(BLANK);

export function useLookState(): State {
  const seed = useContext(SeedContext);
  return useSyncExternalStore(subscribe, () => state, () => seed);
}

/** The design on screen now: the preview, else the saved one (none in safe mode or when off). */
export function activeSpec(s: State): Spec | null {
  if (s.preview) return s.preview.spec;
  if (s.safe || !s.enabled) return null;
  return s.saved?.spec ?? null;
}

export function startPreview(p: Preview) {
  set({ preview: p });
}

const SCHEME_KEY = "depeche:scheme";
const TEXT_KEY = "depeche:text";
const TEXT_STEPS: State["text"][] = ["normal", "bigger", "biggest", "smaller"];

function applyLocal(s: State) {
  const root = document.documentElement;
  if (s.scheme === "auto") delete root.dataset.scheme;
  else root.dataset.scheme = s.scheme;
  if (s.text === "normal") delete root.dataset.text;
  else root.dataset.text = s.text;
}

/** This device's light/dark choice from the light-or-dark button. */
export function toggleScheme() {
  const dark = state.scheme === "dark" || (state.scheme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  setScheme(dark ? "light" : "dark");
}
export function setScheme(scheme: State["scheme"]) {
  set({ scheme });
  try {
    if (scheme === "auto") localStorage.removeItem(SCHEME_KEY);
    else localStorage.setItem(SCHEME_KEY, scheme);
  } catch {
    // Not remembered on this device, but switched for now.
  }
  applyLocal(state);
}
export function cycleTextSize() {
  const text = TEXT_STEPS[(TEXT_STEPS.indexOf(state.text) + 1) % TEXT_STEPS.length];
  set({ text });
  try {
    localStorage.setItem(TEXT_KEY, text);
  } catch {
    // As above.
  }
  applyLocal(state);
}

/**
 * Wraps every signed-in page (see PersonalLook). Draws the look's styles (also when the page is
 * first sent, so there's no flash of the standard look) and the Keep or Undo bar while previewing.
 */
export function LookProvider({ current, offered, safe, enabled, children }: Seed & { children: ReactNode }) {
  const seed = useMemo<State>(() => ({ ...BLANK, saved: current, safe, enabled }), [current, safe, enabled]);
  // In the browser the first page sets the store; later pages refresh what's saved but keep a
  // preview going. (Changing the store here sends no update: everything renders from it anyway.)
  if (typeof window !== "undefined" && (!booted || state.saved?.id !== current?.id || state.safe !== safe || state.enabled !== enabled)) {
    state = { ...state, saved: current, safe, enabled };
    booted = true;
  }
  useEffect(() => {
    // A design the person's admin made for them waits for Keep or Undo.
    if (offered && enabled && !state.preview) set({ preview: { id: offered.id, spec: offered.spec, kind: "offered", by: offered.by } });
    let scheme: State["scheme"] = "auto";
    let text: State["text"] = "normal";
    try {
      const sc = localStorage.getItem(SCHEME_KEY);
      if (sc === "light" || sc === "dark") scheme = sc;
      const t = localStorage.getItem(TEXT_KEY) as State["text"] | null;
      if (t && TEXT_STEPS.includes(t)) text = t;
    } catch {
      // Private browsing: the device's setting.
    }
    set({ scheme, text });
    applyLocal(state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offered?.id]);
  return (
    <SeedContext.Provider value={seed}>
      <LookStyle />
      {children}
    </SeedContext.Provider>
  );
}

function LookStyle() {
  const s = useLookState();
  const spec = activeSpec(s);
  return (
    <>
      <style data-look={spec ? "custom" : "standard"}>{`${BASE_LOOK_CSS}\n${spec ? designCss(spec) : ""}`}</style>
      {s.preview ? <KeepOrUndo key={s.preview.id} preview={s.preview} /> : null}
    </>
  );
}

/** How long a new look waits for Keep before it goes back. */
export const KEEP_SECONDS = 15;

/**
 * Shown over every screen while a look is being tried. Drawn in fixed black and white, whatever the
 * design, so the way back is always readable.
 */
function KeepOrUndo({ preview }: { preview: Preview }) {
  const router = useRouter();
  const [left, setLeft] = useState(KEEP_SECONDS);
  const [busy, setBusy] = useState(false);
  const done = useRef(false);

  const finish = async (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    setBusy(true);
    if (preview.kind === "for") {
      set({ preview: null });
      return;
    }
    if (keep) {
      const r = await keepDesign(preview.id).catch(() => ({ ok: false }));
      set({ preview: null, ...(r.ok ? { saved: { id: preview.id, spec: preview.spec }, safe: false } : {}) });
    } else {
      if (preview.kind !== "history") await undoDesign(preview.id).catch(() => {});
      set({ preview: null });
    }
    // The look itself is already on screen; only My look lists the history, which just changed.
    if (location.pathname.startsWith("/design")) router.refresh();
  };

  useEffect(() => {
    const t = setInterval(() => setLeft((n) => n - 1), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (left <= 0) finish(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left]);

  const title =
    preview.kind === "for"
      ? `This is how ${preview.forName ? `${preview.forName}'s` : "their"} Depeche will look`
      : preview.kind === "offered"
        ? `${preview.by ?? "Your family admin"} made you a new look: ${preview.spec.name}`
        : `New look: ${preview.spec.name}`;
  const bar: React.CSSProperties = {
    background: "#0a0a0a",
    color: "#ffffff",
    fontFamily: "var(--font-geist), system-ui, sans-serif",
    fontSize: 15,
    lineHeight: 1.4,
    letterSpacing: 0,
    textTransform: "none",
    fontStyle: "normal",
    border: "1px solid rgba(255,255,255,0.25)",
    boxShadow: "0 18px 40px -12px rgba(0,0,0,0.6)",
  };
  const btn = (primary: boolean): React.CSSProperties => ({
    background: primary ? "#ffffff" : "transparent",
    color: primary ? "#0a0a0a" : "#ffffff",
    border: "1px solid #ffffff",
    borderRadius: 999,
    padding: "0 18px",
    height: 40,
    fontWeight: 600,
    fontSize: 15,
    fontFamily: "inherit",
  });
  return (
    <div
      role="dialog"
      aria-label="Keep this look?"
      data-testid="keep-or-undo"
      className="fixed inset-x-3 z-[100] mx-auto flex max-w-[560px] flex-col gap-3 rounded-[20px] p-4 sm:inset-x-6"
      style={{ ...bar, top: "max(0.75rem, env(safe-area-inset-top))" }}
    >
      <div className="flex flex-col gap-1">
        <strong style={{ fontWeight: 650 }}>{title}</strong>
        <span style={{ color: "rgba(255,255,255,0.8)" }}>{preview.spec.summary}</span>
        {preview.unmet?.length ? (
          <span style={{ color: "rgba(255,255,255,0.8)" }} data-testid="unmet">
            Couldn&apos;t do yet: {preview.unmet.join("; ")}. Your family admin can see this to-do.
          </span>
        ) : null}
        {preview.adjusted ? <span style={{ color: "rgba(255,255,255,0.8)" }}>Some colours were adjusted so text stays easy to read.</span> : null}
      </div>
      <div className="flex items-center justify-between gap-3">
        <span style={{ color: "rgba(255,255,255,0.7)", fontVariantNumeric: "tabular-nums" }} aria-live="off">
          {preview.kind === "for" ? `They'll get Keep or Undo next time they open Depeche. Closing in ${Math.max(0, left)}s` : `Goes back in ${Math.max(0, left)}s`}
        </span>
        <span className="flex gap-2">
          {preview.kind === "for" ? (
            <button type="button" style={btn(true)} disabled={busy} onClick={() => finish(false)}>
              Close preview
            </button>
          ) : (
            <>
              <button type="button" style={btn(false)} disabled={busy} onClick={() => finish(false)}>
                Undo
              </button>
              <button type="button" style={btn(true)} disabled={busy} onClick={() => finish(true)}>
                Keep
              </button>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

/** Things the extra buttons ask the chat screen to do. */
export const LOOK_ACTION = "depeche:look-action";
export type LookAction = "new-chat" | "chats" | "choose-model" | "voice-chat" | "web-search" | "attach";

/**
 * The extra buttons a design adds in one place. On the chat screen they can do chat things (new
 * chat, voice chat, web search…); on other pages only the links show.
 */
export function Shortcuts({ place, onChat = false, isAdmin = false, className = "" }: { place: Place; onChat?: boolean; isAdmin?: boolean; className?: string }) {
  const s = useLookState();
  const spec = activeSpec(s);
  const list = (spec?.shortcuts ?? []).filter((x) => x.place === place);
  if (!list.length) return null;
  const pill =
    "look-shortcut press inline-flex h-9 shrink-0 items-center rounded-full border border-line bg-bg px-3.5 text-[14px] font-medium text-fg";
  return (
    <div data-part={`shortcuts-${place}`} className={`flex items-center gap-1.5 ${className}`}>
      {list.map((x) => {
        const piece = PIECES[x.piece];
        const label = x.label ?? piece.label;
        if ("admin" in piece && piece.admin && !isAdmin) return null;
        if ("href" in piece) {
          return (
            <Link key={x.piece} href={piece.href} className={pill} data-shortcut={x.piece}>
              {label}
            </Link>
          );
        }
        if (piece.kind === "local") {
          return (
            <button key={x.piece} type="button" className={pill} data-shortcut={x.piece} onClick={x.piece === "light-dark" ? toggleScheme : cycleTextSize}>
              {label}
            </button>
          );
        }
        if (!onChat) {
          return x.piece === "new-chat" ? (
            <Link key={x.piece} href="/" className={pill} data-shortcut={x.piece}>
              {label}
            </Link>
          ) : null;
        }
        return (
          <button
            key={x.piece}
            type="button"
            className={pill}
            data-shortcut={x.piece}
            onClick={() => window.dispatchEvent(new CustomEvent<LookAction>(LOOK_ACTION, { detail: x.piece as LookAction }))}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** The words a design can change on the chat screen, with Depeche's own as the default. */
export function useLookTexts() {
  const spec = activeSpec(useLookState());
  return {
    greeting: (name: string) => (spec?.texts.greeting ? spec.texts.greeting.replaceAll("{name}", name) : `Hi, ${name}.`),
    subtitle: spec?.texts.subtitle,
    placeholder: spec?.texts.placeholder ?? "Message Depeche",
  };
}
