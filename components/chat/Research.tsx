"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RUN_COLUMNS, type RunView } from "@/lib/research/types";
import { siteOf } from "./Sources";

/** How often an open chat checks on research in progress. */
const POLL_MS = 3_000;
/** A run that hasn't moved for this long has lost its hand-over between steps: nudge it along. */
const STALLED_MS = 6 * 60_000;

/**
 * The research runs in one chat, kept up to date while any is running. When one finishes,
 * `onDone` fetches the chat again so its report appears as a reply.
 */
export function useResearch(chatId: string | null, onDone: () => void) {
  const [runs, setRuns] = useState<RunView[]>([]);
  const done = useRef(onDone);
  done.current = onDone;
  const nudged = useRef(new Map<string, number>());

  const load = useCallback(async () => {
    if (!chatId) return;
    const { supabaseBrowser } = await import("@/lib/supabase/browser");
    const { data } = await supabaseBrowser()
      .from("research_runs")
      .select(RUN_COLUMNS)
      .eq("chat_id", chatId)
      .order("created_at")
      .returns<RunView[]>();
    if (!data) return;
    setRuns((before) => {
      const finished = data.some((r) => r.status === "done" && before.some((b) => b.id === r.id && b.status === "running"));
      if (finished) setTimeout(() => done.current(), 0);
      return data;
    });
    // If a step's hand-over was lost (rare), the open chat starts the next step itself.
    for (const r of data) {
      if (r.status !== "running") continue;
      const quiet = Date.now() - new Date(r.updated_at).getTime();
      const last = nudged.current.get(r.id) ?? 0;
      if (quiet > STALLED_MS && Date.now() - last > 60_000) {
        nudged.current.set(r.id, Date.now());
        fetch("/api/research/step", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: r.id }) }).catch(() => {});
      }
    }
  }, [chatId]);

  useEffect(() => {
    setRuns((list) => list.filter((r) => r.chat_id === chatId));
    load();
  }, [chatId, load]);

  const running = runs.some((r) => r.status === "running");
  useEffect(() => {
    if (!running) return;
    const tick = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [running, load]);

  const add = (run: RunView) => setRuns((list) => [...list.filter((r) => r.id !== run.id), run]);
  const stop = async () => {
    const run = runs.find((r) => r.status === "running");
    if (!run) return;
    setRuns((list) => list.map((r) => (r.id === run.id ? { ...r, status: "stopped" } : r)));
    await fetch("/api/research/stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: run.id }) }).catch(() => {});
    load();
  };
  return { runs, running, add, stop, reload: load };
}

/** The research started by this message, unless its report is already on screen. */
export function runFor(runs: RunView[], questionId: string, shownIds: Set<string>): RunView | undefined {
  const run = [...runs].reverse().find((r) => r.question_id === questionId);
  if (!run || (run.status === "done" && run.report_id && shownIds.has(run.report_id))) return undefined;
  return run;
}

/** Progress of deep research: the plan, which questions are done, and the sources found so far. */
export function ResearchCard({ run, onStop }: { run: RunView; onStop: () => void }) {
  const doneCount = run.notes.length;
  const sites = [...new Set(run.sources.map(siteOf).filter(Boolean))];
  const live = run.status === "running";
  const now =
    run.status === "stopped"
      ? "Research stopped."
      : run.status === "failed"
        ? null
        : run.status === "done"
          ? "Report ready."
          : run.phase === "planning"
            ? "Planning the research…"
            : run.phase === "writing"
              ? "Writing the report…"
              : `Researching ${Math.min(doneCount + 1, run.questions.length)} of ${run.questions.length}…`;
  return (
    <section data-testid="research" data-status={run.status} aria-busy={live || undefined} className="flex flex-col gap-3 rounded-[22px] border border-line px-5 py-4">
      <header className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-[13px] font-medium uppercase tracking-[0.08em] text-mute">
          <ResearchIcon className="h-[18px] w-[18px]" /> Deep research
        </span>
        {live ? (
          <button type="button" onClick={onStop} className="press rounded-full border border-line px-3 py-1 text-[13px] hover:border-fg">
            Stop
          </button>
        ) : null}
      </header>
      {run.title ? <h3 className="text-[17px] font-semibold leading-snug">{run.title}</h3> : null}
      {run.questions.length ? (
        <ol className="flex flex-col gap-1.5 text-[15px]">
          {run.questions.map((q, i) => {
            const state = i < doneCount ? (run.notes[i]?.failed ? "failed" : "done") : i === doneCount && live && run.phase === "researching" ? "now" : "todo";
            return (
              <li key={i} data-state={state} className={`flex items-start gap-2.5 ${state === "todo" ? "text-mute" : ""}`}>
                <span aria-hidden className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center">
                  {state === "done" ? "✓" : state === "failed" ? "–" : state === "now" ? <span className="stream-cursor" /> : "○"}
                </span>
                <span className="min-w-0 break-words">{q}</span>
              </li>
            );
          })}
        </ol>
      ) : null}
      {now ? (
        <p className="flex items-center gap-2 text-[15px] text-mute" aria-live="polite">
          {live && run.phase !== "researching" ? <span className="stream-cursor shrink-0" aria-hidden /> : null}
          <span>{now}</span>
        </p>
      ) : null}
      {run.status === "failed" ? (
        <p role="alert" className="rounded-2xl border border-fg px-4 py-3 text-[15px]">
          {run.error ?? "The research couldn't be finished."}
        </p>
      ) : null}
      {run.sources.length ? (
        <p className="min-w-0 truncate text-[13px] text-mute">
          {run.sources.length} {run.sources.length === 1 ? "source" : "sources"} · {sites.slice(0, 4).join(" · ")}
        </p>
      ) : null}
      {live ? <p className="text-[13px] text-mute">This takes a few minutes. You can close the app; the report will be here when it&apos;s done.</p> : null}
    </section>
  );
}

/** A magnifying glass over lines of text: research, as opposed to a single web search (the globe). */
export const ResearchIcon = ({ className }: { className?: string }) => (
  <svg
    width={22}
    height={22}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    className={className}
  >
    <path d="M4 6h9M4 10.5h5M4 15h4" />
    <circle cx="15.5" cy="14" r="4.5" />
    <path d="M18.8 17.3L21 19.5" />
  </svg>
);
