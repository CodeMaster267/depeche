"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { findModel } from "@/lib/ai/models";
import type { MessageRow } from "@/lib/chat/thread";

/**
 * Two or three models' answers to the same question, side by side. On phones each answer fills
 * the width and you swipe between them (the next one peeks in from the edge); on wider screens
 * two sit next to each other. The tabs above jump to an answer. "Continue with this" picks the
 * answer the conversation carries on from; the others are kept and can be picked later.
 */
export function Compare<T extends MessageRow & { streaming?: boolean }>({
  replies,
  chosenId,
  onChoose,
  canChoose,
  renderReply,
}: {
  replies: T[];
  chosenId: string;
  onChoose: (id: string) => void;
  /** Picking is only offered for the newest question, once nothing is still being written. */
  canChoose: boolean;
  renderReply: (m: T) => ReactNode;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(() => Math.max(0, replies.findIndex((m) => m.id === chosenId)));

  // Start on the chosen answer (after a reload it may not be the first).
  const first = useRef(true);
  useEffect(() => {
    if (!first.current) return;
    first.current = false;
    const el = strip.current;
    const pane = el?.children[shown] as HTMLElement | undefined;
    if (el && pane && shown > 0) el.scrollLeft = pane.offsetLeft - (el.firstElementChild as HTMLElement).offsetLeft;
  }, [shown]);

  const goTo = (i: number) => {
    const el = strip.current;
    const pane = el?.children[i] as HTMLElement | undefined;
    if (!el || !pane) return;
    setShown(i);
    el.scrollTo({ left: pane.offsetLeft - (el.firstElementChild as HTMLElement).offsetLeft, behavior: "smooth" });
  };

  const onScroll = () => {
    const el = strip.current;
    if (!el) return;
    // The answer whose left edge is nearest the strip's left edge is the one being read.
    const start = (el.firstElementChild as HTMLElement).offsetLeft;
    let best = 0;
    let distance = Infinity;
    [...el.children].forEach((c, i) => {
      const d = Math.abs((c as HTMLElement).offsetLeft - start - el.scrollLeft);
      if (d < distance) {
        distance = d;
        best = i;
      }
    });
    setShown(best);
  };

  return (
    <section data-testid="compare" aria-label={`Answers from ${replies.length} models`} className="flex flex-col gap-3">
      <div
        role="tablist"
        aria-label="Answers"
        className="-mx-5 flex items-center gap-1.5 overflow-x-auto px-5 md:mx-0 md:px-0"
        style={{ scrollbarWidth: "none" }}
      >
        {replies.map((m, i) => {
          const name = findModel(m.model)?.short ?? m.model ?? "Model";
          const chosen = m.id === chosenId;
          return (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={i === shown}
              aria-label={`${name}${chosen ? ", continuing with this" : ""}`}
              onClick={() => goTo(i)}
              className={`press flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-[14px] transition-colors ${
                i === shown ? "border-fg bg-inv text-on-inv" : "border-line text-mute"
              }`}
            >
              {chosen ? <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${i === shown ? "bg-on-inv" : "bg-fg"}`} /> : null}
              {name}
              {m.streaming ? <span className="sr-only"> (writing)</span> : null}
            </button>
          );
        })}
      </div>
      <div
        ref={strip}
        onScroll={onScroll}
        data-testid="compare-strip"
        className="-mx-5 flex snap-x snap-mandatory items-start gap-3 overflow-x-auto overscroll-x-contain px-5 md:-mx-0 md:px-0"
        style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}
      >
        {replies.map((m, i) => {
          const name = findModel(m.model)?.name ?? m.model ?? "Model";
          const chosen = m.id === chosenId;
          return (
            <div
              key={m.id}
              role="tabpanel"
              aria-label={name}
              data-testid="compare-pane"
              data-chosen={chosen || undefined}
              className={`w-[88%] shrink-0 snap-start scroll-ml-5 rounded-[22px] border p-4 md:w-[calc(50%-6px)] md:scroll-ml-0 ${
                chosen ? "border-fg" : "border-line"
              }`}
              onFocusCapture={() => i !== shown && setShown(i)}
            >
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="truncate text-[15px] font-semibold">{name}</h3>
                {chosen ? (
                  <span className="shrink-0 text-[13px] text-mute">{canChoose ? "Continuing with this" : "Picked"}</span>
                ) : canChoose && !m.streaming && m.status === "completed" ? (
                  <button
                    type="button"
                    onClick={() => onChoose(m.id)}
                    className="press shrink-0 rounded-full border border-fg px-3 py-1 text-[13px]"
                  >
                    Continue with this
                  </button>
                ) : null}
              </div>
              {renderReply(m)}
            </div>
          );
        })}
      </div>
      {replies.length > 1 ? (
        <div aria-hidden className="flex justify-center gap-1.5 md:hidden">
          {replies.map((m, i) => (
            <span key={m.id} className={`h-1.5 w-1.5 rounded-full ${i === shown ? "bg-fg" : "bg-line"}`} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
