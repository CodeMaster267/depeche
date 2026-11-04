"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { Markdown } from "@/components/markdown/Markdown";
import { ArrowUpIcon, CloseIcon, StopIcon } from "@/components/chat/icons";

/**
 * Concierge, the help assistant: a panel that answers "how do I…" questions about Depeche. It slides
 * up from the bottom on phones and sits at the right on wider screens. The conversation lives only
 * in this browser tab (session storage), so it survives moving between pages but isn't saved.
 */

type Turn = { role: "user" | "assistant"; text: string; error?: boolean };

const STORE = "depeche-concierge";
const MAX_KEPT = 30;

/** A little service bell, Concierge's mark. */
export const BellIcon = ({ className }: { className?: string }) => (
  <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
    <path d="M3 18.5h18M5 18.5a7 7 0 0 1 14 0M12 11.5V9.5M10.5 9.5h3" />
  </svg>
);

function load(): Turn[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(STORE) ?? "[]");
    return Array.isArray(raw) ? raw.filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.text === "string") : [];
  } catch {
    return [];
  }
}

function save(turns: Turn[]) {
  try {
    sessionStorage.setItem(STORE, JSON.stringify(turns.slice(-MAX_KEPT)));
  } catch {
    // Private browsing: the conversation just isn't kept between pages.
  }
}

/**
 * The way in: `row` for the side menu (a quiet line like "Archived chats"), `icon` for the top bar
 * of settings pages (a small round glass button).
 */
export function ConciergeButton({ variant, isAdmin = false, onOpen }: { variant: "row" | "icon"; isAdmin?: boolean; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  const show = () => {
    onOpen?.();
    setOpen(true);
  };
  return (
    <>
      {variant === "row" ? (
        <button
          type="button"
          data-part="concierge-link"
          onClick={show}
          className="mb-2 flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-[15px] text-mute hover:bg-soft"
        >
          <BellIcon />
          <span>Ask Concierge</span>
        </button>
      ) : (
        <button
          type="button"
          data-part="concierge-button"
          onClick={show}
          aria-label="Ask Concierge"
          title="Concierge: ask how anything works"
          className="press glass flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
        >
          <BellIcon className="h-[18px] w-[18px]" />
        </button>
      )}
      {open ? <ConciergePanel isAdmin={isAdmin} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function ConciergePanel({ isAdmin, onClose }: { isAdmin: boolean; onClose: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const stop = useRef<AbortController | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const router = useRouter();
  const page = usePathname();

  useEffect(() => setTurns(load()), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    // Keep the page behind still while the panel is open on a phone.
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      stop.current?.abort();
    };
  }, [onClose]);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [turns]);

  const ideas = [
    isAdmin ? "Where do I put my xAI key?" : "How do I get a new model added?",
    "What is prompt caching and how do I use it?",
    "How do I lock Depeche with Face ID?",
    "How do I make a picture?",
  ];

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setValue("");
    const before = turns.filter((t) => !t.error);
    const next: Turn[] = [...before, { role: "user", text: q }];
    setTurns([...next, { role: "assistant", text: "" }]);
    setBusy(true);
    const ctrl = new AbortController();
    stop.current = ctrl;
    let answer = "";
    let error: string | null = null;
    try {
      const res = await fetch("/api/help", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turns: next.map(({ role, text }) => ({ role, text })), page }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        error = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Concierge couldn't answer. Try again.";
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const ev = JSON.parse(line) as { type: string; text?: string; name?: string; error?: string };
            if (ev.type === "model" && ev.name) setModel(ev.name);
            else if (ev.type === "text" && ev.text) {
              answer += ev.text;
              setTurns([...next, { role: "assistant", text: answer }]);
            } else if (ev.type === "error") error = ev.error ?? "Concierge couldn't answer. Try again.";
          }
        }
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) error = "Couldn't reach Concierge. Check your connection and try again.";
    }
    stop.current = null;
    setBusy(false);
    const final: Turn[] = error && !answer ? [...next, { role: "assistant", text: error, error: true }] : [...next, { role: "assistant", text: answer || "…" }];
    setTurns(final);
    save(final);
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    ask(value);
  };
  const clear = () => {
    stop.current?.abort();
    setTurns([]);
    save([]);
    box.current?.focus();
  };

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-stretch sm:justify-end" role="presentation">
      <button type="button" aria-label="Close Concierge" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Concierge"
        data-part="concierge"
        className="enter-glitch relative flex h-[88dvh] w-full flex-col rounded-t-[28px] bg-bg sm:h-full sm:max-w-[440px] sm:rounded-none sm:border-l sm:border-line"
        // Links to Depeche's own pages open here, in the app; links to the web open in a new tab.
        onClickCapture={(e) => {
          const a = (e.target as HTMLElement).closest("a");
          const href = a?.getAttribute("href");
          if (!href || !href.startsWith("/") || href.startsWith("//")) return;
          e.preventDefault();
          onClose();
          router.push(href);
        }}
      >
        <div className="mx-auto mt-2.5 h-1.5 w-10 shrink-0 rounded-full bg-line sm:hidden" />
        <header className="flex shrink-0 items-start gap-3 border-b border-line px-5 pb-4 pt-3 sm:pt-[max(1.25rem,env(safe-area-inset-top))]">
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-inv text-on-inv">
            <BellIcon />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[22px] font-semibold leading-tight tracking-tight">Concierge</h2>
            <p className="text-[14px] text-mute">Ask how anything in Depeche works.</p>
          </div>
          {turns.length ? (
            <button type="button" onClick={clear} className="press rounded-full px-3 py-2 text-[14px] text-mute hover:text-fg">
              Clear
            </button>
          ) : null}
          <button type="button" onClick={onClose} aria-label="Close" className="press -mr-2 rounded-full p-2 text-mute hover:text-fg">
            <CloseIcon />
          </button>
        </header>

        <div ref={list} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5" aria-live="polite">
          {turns.length ? (
            <ul className="flex flex-col gap-5">
              {turns.map((t, i) =>
                t.role === "user" ? (
                  <li key={i} className="self-end whitespace-pre-wrap break-words rounded-[20px] bg-soft px-4 py-2.5 text-[16px] max-w-[85%]">
                    {t.text}
                  </li>
                ) : (
                  <li key={i} data-part="concierge-answer" className={`text-[16px] ${t.error ? "text-mute" : ""}`}>
                    {t.text ? (
                      t.error ? <p>{t.text}</p> : <Markdown text={t.text} streaming={busy && i === turns.length - 1} />
                    ) : (
                      <span className="concierge-dots inline-flex h-6 items-center gap-1.5 text-mute" aria-label="Thinking">
                        <i />
                        <i />
                        <i />
                      </span>
                    )}
                  </li>
                ),
              )}
            </ul>
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-[16px] text-mute">
                What a button does, where a setting lives, how to add a key: ask in your own words.
              </p>
              <ul className="flex flex-col gap-2" aria-label="Ideas">
                {ideas.map((idea) => (
                  <li key={idea}>
                    <button
                      type="button"
                      onClick={() => ask(idea)}
                      className="press w-full rounded-2xl border border-line px-4 py-3 text-left text-[15px] hover:bg-soft"
                    >
                      {idea}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <form onSubmit={submit} className="shrink-0 border-t border-line px-4 pt-3" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
          <div className="flex items-end gap-2 rounded-[24px] bg-soft py-1 pl-4 pr-1">
            <textarea
              ref={box}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
                  e.preventDefault();
                  ask(value);
                }
              }}
              rows={1}
              maxLength={2000}
              placeholder="Ask Concierge"
              aria-label="Ask Concierge"
              className="max-h-[140px] min-h-[44px] flex-1 resize-none bg-transparent py-2.5 text-[16px] leading-6 outline-none placeholder:text-faint"
            />
            {busy ? (
              <button type="button" onClick={() => stop.current?.abort()} aria-label="Stop" className="press glass flex h-10 w-10 shrink-0 items-center justify-center rounded-full">
                <StopIcon />
              </button>
            ) : (
              <button
                type="submit"
                aria-label="Ask"
                disabled={!value.trim()}
                className="press flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-inv text-on-inv disabled:opacity-30"
              >
                <ArrowUpIcon />
              </button>
            )}
          </div>
          <p className="px-2 pt-2 text-center text-[12px] text-faint">
            {model ? `Answers by ${model}. ` : ""}Knows Depeche, not your chats. Counts toward your monthly limit.
          </p>
        </form>
      </div>
    </div>,
    document.body,
  );
}
