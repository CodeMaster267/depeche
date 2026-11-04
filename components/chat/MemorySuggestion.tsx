"use client";

import { useState, useTransition } from "react";
import { decideMemory, rememberFact, type MemoryOutcome } from "@/app/memory/actions";
import { MemoryOutcomeView } from "./MemoryOutcome";

/**
 * A reply offered to remember something. Nothing is kept unless the person taps Remember, and
 * even then it's first checked against what's already remembered (smart memory).
 */
export function MemorySuggestion({ memory }: { memory: { id: string; content: string } }) {
  const [outcome, setOutcome] = useState<MemoryOutcome | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [pending, start] = useTransition();
  // "No thanks" hides the card at once. The result of Remember shows only once it is saved, so
  // leaving the page straight away can't lose it.
  const remember = () =>
    start(async () => {
      setOutcome(await rememberFact({ suggestionId: memory.id, from: "chat" }));
    });
  const noThanks = () => {
    setDismissed(true);
    start(async () => {
      await decideMemory(memory.id, false);
    });
  };

  if (dismissed) return null;
  if (outcome) {
    return (
      <MemoryOutcomeView
        outcome={outcome}
        from="chat"
        suggestionId={memory.id}
        onChange={(next) => (next ? setOutcome(next) : setDismissed(true))}
      />
    );
  }
  return (
    <div data-testid="memory-suggestion" className="flex flex-col gap-3 rounded-2xl border border-line px-4 py-3.5">
      <p className="text-[13px] font-semibold uppercase tracking-[0.1em] text-mute">Remember this?</p>
      <p className="text-[16px] leading-relaxed">{memory.content}</p>
      <div className="flex gap-2">
        <button type="button" disabled={pending} onClick={remember} className="press h-10 rounded-full bg-inv px-4 text-[15px] font-medium text-on-inv">
          {pending ? "Checking…" : "Remember"}
        </button>
        <button type="button" disabled={pending} onClick={noThanks} className="press h-10 rounded-full border border-line px-4 text-[15px]">
          No thanks
        </button>
      </div>
    </div>
  );
}
