"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { decideMemory } from "@/app/memory/actions";

/** A reply offered to remember something. Nothing is kept unless the person taps Remember. */
export function MemorySuggestion({ memory }: { memory: { id: string; content: string } }) {
  const [answer, setAnswer] = useState<"kept" | "dismissed" | null>(null);
  const [pending, start] = useTransition();
  const decide = (keep: boolean) => {
    setAnswer(keep ? "kept" : "dismissed");
    start(() => decideMemory(memory.id, keep));
  };

  if (answer === "dismissed") return null;
  if (answer === "kept") {
    return (
      <p role="status" className="text-[14px] text-mute">
        Remembered.{" "}
        <Link href="/memory" className="underline underline-offset-4">
          See memory
        </Link>
      </p>
    );
  }
  return (
    <div data-testid="memory-suggestion" className="flex flex-col gap-3 rounded-2xl border border-line px-4 py-3.5">
      <p className="text-[13px] font-semibold uppercase tracking-[0.1em] text-mute">Remember this?</p>
      <p className="text-[16px] leading-relaxed">{memory.content}</p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => decide(true)}
          className="press h-10 rounded-full bg-inv px-4 text-[15px] font-medium text-on-inv"
        >
          Remember
        </button>
        <button type="button" disabled={pending} onClick={() => decide(false)} className="press h-10 rounded-full border border-line px-4 text-[15px]">
          No thanks
        </button>
      </div>
    </div>
  );
}
