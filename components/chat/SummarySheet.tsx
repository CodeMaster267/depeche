"use client";

import { useEffect, useRef, useState } from "react";
import { findModel } from "@/lib/ai/models";
import type { SummaryRow } from "@/lib/chat/summary";
import { CloseIcon } from "./icons";

/** The thin line where a chat's summary takes over. Tapping it opens the summary. */
export function SummaryLine({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      data-testid="summary-line"
      onClick={onOpen}
      className="flex w-full items-center gap-3 text-[13px] text-mute hover:text-fg"
    >
      <span className="h-px flex-1 bg-line" />
      <span>Earlier messages summarised</span>
      <span className="h-px flex-1 bg-line" />
    </button>
  );
}

/**
 * What the model is given instead of the earlier messages, which stay in the chat unchanged. The
 * person can redo the summary, stop using it, or turn summaries off for this chat.
 */
export function SummarySheet({
  summary,
  onClose,
  onRedo,
  onDiscard,
  onTurnOff,
}: {
  summary: SummaryRow;
  onClose: () => void;
  onRedo: () => Promise<string | null>;
  onDiscard: () => Promise<void>;
  onTurnOff: () => Promise<void>;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [working, setWorking] = useState<"redo" | "discard" | "off" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    panel.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const model = findModel(summary.model);
  const cost = Number(summary.cost_usd);
  const when = new Date(summary.created_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const act = async (what: "redo" | "discard" | "off", fn: () => Promise<string | null | void>) => {
    setWorking(what);
    setError(null);
    const problem = await fn().catch(() => "Something went wrong. Try again.");
    setWorking(null);
    if (problem) setError(problem);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-start sm:pt-[10vh]" role="presentation">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Summary of earlier messages"
        className="enter-glitch relative flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-t-[28px] bg-bg outline-none sm:max-w-[560px] sm:rounded-[24px] sm:border sm:border-line"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-line sm:hidden" />
        <div className="flex items-start justify-between gap-3 px-6 pb-2 pt-4">
          <div>
            <h2 className="text-[24px] font-semibold tracking-tight">Earlier messages summarised</h2>
            <p className="mt-1 text-[14px] text-mute">
              To keep this long chat fast and cheap, the model now reads this summary instead of the messages above the line. Those
              messages are kept, unchanged.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 shrink-0 p-2 text-mute">
            <CloseIcon />
          </button>
        </div>
        <div className="overflow-y-auto overscroll-contain px-6 pb-4">
          <p data-testid="summary-text" className="whitespace-pre-wrap break-words text-[16px] leading-relaxed">
            {summary.summary}
          </p>
          {summary.facts.length ? (
            <>
              <h3 className="pb-1 pt-5 text-[12px] font-semibold uppercase tracking-[0.1em] text-mute">Key facts</h3>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-[15px] leading-relaxed">
                {summary.facts.map((f, i) => (
                  <li key={i} className="break-words">
                    {f}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="mt-5 font-mono text-[12px] text-mute">
            {model?.short ?? summary.model} · {when}
            {cost > 0 ? ` · $${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}` : ""}
          </p>
        </div>
        <div className="flex flex-col gap-2 border-t border-line px-6 py-4">
          {error ? (
            <p role="alert" className="text-[14px]">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            disabled={!!working}
            onClick={() => act("redo", onRedo)}
            className="press h-11 rounded-full bg-inv px-4 text-[15px] font-medium text-on-inv disabled:opacity-50"
          >
            {working === "redo" ? "Summarising…" : "Redo summary"}
          </button>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              disabled={!!working}
              onClick={() => act("discard", onDiscard)}
              className="press h-11 flex-1 rounded-full border border-line px-3 text-[15px] disabled:opacity-50"
            >
              Don&apos;t use this summary
            </button>
            <button
              type="button"
              disabled={!!working}
              onClick={() => act("off", onTurnOff)}
              className="press h-11 flex-1 rounded-full border border-line px-3 text-[15px] disabled:opacity-50"
            >
              Turn off for this chat
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
