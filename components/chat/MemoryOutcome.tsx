"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { MAX_MEMORY_CHARS } from "@/lib/chat/memory";
import { rememberFact, settleConflict, undoReplace, type MemoryOutcome } from "@/app/memory/actions";

type Props = {
  outcome: MemoryOutcome;
  /** Where this is shown. In a chat, the result links to the memory page. */
  from: "chat" | "page";
  /** The reply's suggestion this came from, if any. */
  suggestionId?: string;
  /** A new outcome (after the person answers a clash or rewrites the fact). */
  onChange: (next: MemoryOutcome | null) => void;
};

/**
 * What happened when something was offered to memory: kept, already there, merged into older
 * memories (with Undo), or a clash the person settles. Nothing that clashes is kept until they say.
 */
export function MemoryOutcomeView({ outcome, from, suggestionId, onChange }: Props) {
  const [pending, start] = useTransition();
  const [rewriting, setRewriting] = useState(false);
  const [draft, setDraft] = useState(outcome.kind === "conflict" ? outcome.fact : "");
  const [undone, setUndone] = useState(false);
  const seeMemory =
    from === "chat" ? (
      <>
        {" "}
        <Link href="/memory" className="underline underline-offset-4">
          See memory
        </Link>
      </>
    ) : null;

  if (outcome.kind === "error") {
    return (
      <p role="alert" className="text-[14px] text-mute">
        {outcome.error}
      </p>
    );
  }
  if (outcome.kind === "saved") {
    return (
      <p role="status" className="text-[14px] text-mute" data-testid="memory-outcome">
        Remembered.{seeMemory}
      </p>
    );
  }
  if (outcome.kind === "duplicate") {
    return (
      <p role="status" className="text-[14px] text-mute" data-testid="memory-outcome">
        Already remembered: {outcome.content}
        {seeMemory}
      </p>
    );
  }
  if (outcome.kind === "updated") {
    if (undone) {
      return (
        <p role="status" className="text-[14px] text-mute" data-testid="memory-outcome">
          Undone. Depeche remembers it as before.
        </p>
      );
    }
    return (
      <div role="status" className="flex flex-col gap-1 text-[14px] text-mute" data-testid="memory-outcome">
        <p>
          Updated memory: <span className="text-fg">{outcome.content}</span>
        </p>
        <p>
          It replaces: {outcome.replaced.join(" ")}{" "}
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                await undoReplace(outcome.id, from);
                setUndone(true);
              })
            }
            className="underline underline-offset-4"
          >
            Undo
          </button>
          {seeMemory}
        </p>
      </div>
    );
  }

  // A clash, or it isn't clear who the fact is about: the person decides.
  const settle = (choice: "new" | "old" | "both") =>
    start(async () => {
      const next = await settleConflict({ choice, fact: outcome.fact, about: outcome.about, clashes: outcome.clashes.map((c) => c.id), suggestionId, from });
      // Not saving something that clashed with nothing simply closes the card.
      onChange(choice === "old" && !outcome.clashes.length && next.kind !== "error" ? null : next);
    });
  const recheck = () =>
    start(async () => {
      const next = await rememberFact({ content: draft, suggestionId, from });
      setRewriting(false);
      onChange(next);
    });
  const button = "press h-10 rounded-full border border-line px-4 text-[15px]";
  const main = "press h-10 rounded-full bg-inv px-4 text-[15px] font-medium text-on-inv";
  return (
    <div data-testid="memory-conflict" className="flex flex-col gap-3 rounded-2xl border border-line px-4 py-3.5">
      <p className="text-[13px] font-semibold uppercase tracking-[0.1em] text-mute">Check this</p>
      <p className="text-[16px] leading-relaxed">{outcome.question}</p>
      {outcome.clashes.length ? (
        <div className="flex flex-col gap-1 text-[15px]">
          <p className="text-mute">Depeche remembers:</p>
          <ul className="flex flex-col gap-1" data-testid="memory-clashes">
            {outcome.clashes.map((c) => (
              <li key={c.id} className="leading-relaxed">
                {c.content}
              </li>
            ))}
          </ul>
          <p className="pt-1 text-mute">New:</p>
          <p className="leading-relaxed">{outcome.fact}</p>
        </div>
      ) : (
        <p className="text-[15px] leading-relaxed">{outcome.fact}</p>
      )}
      {rewriting ? (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-[14px] text-mute">Say who it&apos;s about, for example &quot;My brother is 19&quot;.</span>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              maxLength={MAX_MEMORY_CHARS}
              aria-label="Write it differently"
              className="resize-none rounded-2xl border border-line bg-bg px-4 py-3 text-[17px] outline-none focus:border-fg"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={pending || !draft.trim()} onClick={recheck} className={main}>
              {pending ? "Checking…" : "Check again"}
            </button>
            <button type="button" disabled={pending} onClick={() => setRewriting(false)} className={button}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {outcome.clashes.length ? (
              <>
                <button type="button" disabled={pending} onClick={() => settle("new")} className={main}>
                  Use the new one
                </button>
                <button type="button" disabled={pending} onClick={() => settle("old")} className={button}>
                  Keep the old one
                </button>
                <button type="button" disabled={pending} onClick={() => settle("both")} className={button}>
                  Both are right
                </button>
              </>
            ) : (
              <>
                <button type="button" disabled={pending} onClick={() => setRewriting(true)} className={main}>
                  Say who it&apos;s about
                </button>
                <button type="button" disabled={pending} onClick={() => settle("both")} className={button}>
                  Save as it is
                </button>
                <button type="button" disabled={pending} onClick={() => settle("old")} className={button}>
                  Don&apos;t save
                </button>
              </>
            )}
          </div>
          {outcome.clashes.length ? (
            <button type="button" disabled={pending} onClick={() => setRewriting(true)} className="self-start text-[15px] text-mute underline underline-offset-4">
              Write it differently
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
