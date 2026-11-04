"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { MAX_QUOTE_CHARS } from "@/lib/chat/followups";
import type { MessageRow } from "@/lib/chat/thread";
import { CloseIcon } from "./icons";

/**
 * Answer extras: asking about a selected part of an answer, follow-up questions under the newest
 * answer, and what each answer cost.
 */

const shorten = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

/**
 * A floating "Ask about this" button that appears under text selected inside an answer. It sits
 * below the selection so it never covers the phone's own Copy menu, which iOS shows above.
 */
export function AskAboutSelection({ scroller, onAsk }: { scroller: RefObject<HTMLElement | null>; onAsk: (text: string) => void }) {
  const [spot, setSpot] = useState<{ text: string; x: number; y: number } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pressing = useRef(false);

  useEffect(() => {
    const read = () => {
      const sel = document.getSelection();
      const picked = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null;
      // Chrome can report an empty selection for text it hasn't drawn yet, so fall back to the range.
      const text = picked ? (sel!.toString() || picked.toString()).trim() : "";
      const range = text ? picked : null;
      const node = range?.commonAncestorContainer;
      const el = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;
      const inside = el?.closest("[data-reply-text]");
      if (!range || !inside || !scroller.current?.contains(inside) || inside.closest('[aria-busy="true"]')) {
        // Tapping the button can clear the selection first on phones, so wait a moment.
        clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => !pressing.current && setSpot(null), 300);
        return;
      }
      clearTimeout(hideTimer.current);
      const rects = [...range.getClientRects()].filter((r) => r.width || r.height);
      const last = rects.at(-1) ?? range.getBoundingClientRect();
      const box = scroller.current.getBoundingClientRect();
      const x = Math.min(Math.max(last.left + last.width / 2, box.left + 70), box.right - 70);
      // Below the selection, but always inside the chat, even if the selection runs off it.
      const y = Math.max(box.top + 8, Math.min(last.bottom + 12, box.bottom - 52));
      setSpot({ text: text.slice(0, MAX_QUOTE_CHARS), x, y });
    };
    let frame = 0;
    const onChange = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    };
    const hide = () => setSpot(null);
    document.addEventListener("selectionchange", onChange);
    // Something may already be selected by the time the page is ready.
    onChange();
    const el = scroller.current;
    el?.addEventListener("scroll", onChange, { passive: true });
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("selectionchange", onChange);
      el?.removeEventListener("scroll", onChange);
      window.removeEventListener("resize", hide);
      cancelAnimationFrame(frame);
      clearTimeout(hideTimer.current);
    };
  }, [scroller]);

  if (!spot) return null;
  return (
    <button
      type="button"
      data-testid="ask-about-selection"
      className="press glass fixed z-30 flex h-10 -translate-x-1/2 items-center rounded-full px-4 text-[15px] font-medium"
      style={{ left: spot.x, top: spot.y }}
      // Keep the selection while pressing, so it isn't lost before the tap lands.
      onPointerDown={(e) => {
        pressing.current = true;
        e.preventDefault();
      }}
      onPointerUp={() => (pressing.current = false)}
      onPointerCancel={() => (pressing.current = false)}
      onClick={() => {
        pressing.current = false;
        onAsk(spot.text);
        setSpot(null);
        document.getSelection()?.removeAllRanges();
      }}
    >
      Ask about this
    </button>
  );
}

/** The selected text the next message will ask about, shown at the top of the message box. */
export function QuoteChip({ quote, onClear }: { quote: string; onClear: () => void }) {
  return (
    <div data-testid="quote-chip" className="mx-1 mb-1 flex items-start gap-2 rounded-2xl bg-soft py-2 pl-3.5 pr-1.5">
      <p className="min-w-0 flex-1 border-l-2 border-fg pl-2.5 text-[14px] leading-snug text-mute">
        <span className="sr-only">Asking about: </span>
        <span className="line-clamp-2">{quote}</span>
      </p>
      <button type="button" aria-label="Don't ask about this" onClick={onClear} className="press -my-0.5 shrink-0 rounded-full p-1.5 text-mute hover:text-fg">
        <CloseIcon className="h-[18px] w-[18px]" />
      </button>
    </div>
  );
}

/** Above a question: the part of an answer it was asking about. */
export function QuoteLine({ quote }: { quote: string }) {
  return (
    <p data-testid="message-quote" className="max-w-[85%] border-r-2 border-line pr-3 text-right text-[14px] leading-snug text-mute">
      <span className="sr-only">About: </span>
      {shorten(quote.replace(/\s+/g, " "), 160)}
    </p>
  );
}

/** Questions the model suggested asking next. Tapping one sends it. */
export function FollowUps({ questions, onAsk, disabled }: { questions: string[]; onAsk: (q: string) => void; disabled?: boolean }) {
  if (!questions.length) return null;
  return (
    <nav aria-label="Suggested follow-ups" data-testid="followups" className="flex flex-col items-start gap-2">
      {questions.map((q) => (
        <button
          key={q}
          type="button"
          disabled={disabled}
          onClick={() => onAsk(q)}
          className="press max-w-full rounded-2xl border border-line px-4 py-2 text-left text-[15px] leading-snug hover:border-fg disabled:opacity-40"
        >
          {q}
        </button>
      ))}
    </nav>
  );
}

/** Dollars as people read them: tiny amounts with enough places to be more than zero. */
export function formatCost(cost: number): string {
  if (cost <= 0) return "$0";
  if (cost < 0.0001) return "<$0.0001";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

const tokens = (n: number) => `${n.toLocaleString("en-GB")} ${n === 1 ? "token" : "tokens"}`;

/** What an answer cost. Tap it for the tokens and searches behind the number. */
export function CostButton({ content }: { content: MessageRow["content"] }) {
  const [open, setOpen] = useState(false);
  const cost = typeof content.cost === "number" ? content.cost : null;
  const usage = content.usage;
  if (cost === null || (cost <= 0 && !usage)) return null;
  return (
    <span className="relative">
      <button
        type="button"
        data-testid="message-cost"
        aria-expanded={open}
        aria-label={`Cost ${formatCost(cost)}. Show details`}
        onClick={() => setOpen(!open)}
        className="rounded-md px-1 py-0.5 hover:text-fg"
      >
        {formatCost(cost)}
      </button>
      {open ? (
        <>
          <button type="button" aria-label="Close" tabIndex={-1} className="fixed inset-0 z-20 cursor-default" onClick={() => setOpen(false)} />
          <span
            role="dialog"
            aria-label="What this answer cost"
            data-testid="cost-details"
            className="absolute bottom-full right-0 z-30 mb-2 flex w-60 flex-col gap-1 rounded-2xl border border-line bg-bg px-4 py-3 text-left font-sans text-[14px] text-fg shadow-lg"
          >
            <span className="flex justify-between gap-3">
              <span className="text-mute">Cost</span>
              <span>{formatCost(cost)}</span>
            </span>
            {usage ? (
              <>
                <span className="flex justify-between gap-3">
                  <span className="text-mute">Read</span>
                  <span>{tokens(usage.input)}</span>
                </span>
                {usage.cached ? (
                  <span className="flex justify-between gap-3" data-testid="cost-cached">
                    <span className="text-mute">Of that, reused</span>
                    <span>{tokens(usage.cached)}</span>
                  </span>
                ) : null}
                <span className="flex justify-between gap-3">
                  <span className="text-mute">Wrote</span>
                  <span>{tokens(usage.output)}</span>
                </span>
              </>
            ) : null}
            {content.searches ? (
              <span className="flex justify-between gap-3">
                <span className="text-mute">Web searches</span>
                <span>{content.searches}</span>
              </span>
            ) : null}
            <span className="mt-1 text-[12px] leading-snug text-mute">
              {usage?.estimated ? "Estimated, as the answer was stopped early. " : ""}
              {usage?.cached ? "Reused tokens were read back from the provider's cache at a much lower price. " : ""}
              Worked out from the provider&apos;s list prices; your family&apos;s bill may differ slightly.
            </span>
          </span>
        </>
      ) : null}
    </span>
  );
}
