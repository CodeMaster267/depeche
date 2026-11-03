"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { Markdown } from "@/components/markdown/Markdown";
import { thoughtFor } from "@/lib/chat/activity";
import type { MessageRow } from "@/lib/chat/thread";
import { siteOf } from "./Sources";
import { ChevronDownIcon } from "./icons";

/** What the reply is doing right now, while it streams. */
export type LiveActivity = {
  streaming?: boolean;
  thinkingNow?: boolean;
  /** When the current spell of thinking began (ms), for the live timer. */
  thinkingSince?: number;
  /** Thinking already finished in earlier spells (ms). */
  thoughtSoFar?: number;
  searchingNow?: boolean;
  queries?: string[];
};

/**
 * The short lines above a reply that say what it did before (or while) writing: "Read
 * report.pdf", "Thought for 12s", "Searched the web · 3 sources". Thinking and searching open to
 * show the reasoning, the searches and the pages found; nothing else is shown until asked for.
 */
export function Activity({ message: m }: { message: MessageRow & LiveActivity }) {
  const c = m.content;
  const queries = c.queries ?? m.queries ?? [];
  const reasoning = c.reasoning ?? "";
  const searched = !!(m.searchingNow || queries.length || c.sources?.length || c.searches);
  const read = c.read ?? [];
  if (!read.length && !reasoning && !m.thinkingNow && !searched) return null;
  return (
    <div data-testid="activity" className="flex flex-col items-start gap-0.5">
      {read.map((name, i) => (
        <p key={`${i}-${name}`} data-testid="activity-read" className="flex min-w-0 max-w-full items-center gap-2 py-1 text-[15px] text-mute">
          <span className="min-w-0 truncate">
            {/\.(png|jpe?g|gif|webp|heic|heif|avif)$/i.test(name) ? "Viewed" : "Read"} {name}
          </span>
        </p>
      ))}
      {reasoning || m.thinkingNow ? <Thought m={m} reasoning={reasoning} /> : null}
      {searched ? <Searched m={m} queries={queries} /> : null}
    </div>
  );
}

/** A line that opens to show more underneath it, indented on a thin rule. */
function Line({ label, live, testId, children }: { label: ReactNode; live?: boolean; testId: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section data-testid={testId} className="flex w-full flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        disabled={!children}
        onClick={() => setOpen(!open)}
        className="press -mx-1 flex min-h-9 max-w-full items-center gap-2 self-start rounded-lg px-1 text-left text-[15px] text-mute hover:text-fg disabled:hover:text-mute"
      >
        {live ? <span className="stream-cursor shrink-0" aria-hidden /> : null}
        <span className="min-w-0 truncate">{label}</span>
        {children ? <ChevronDownIcon className={`shrink-0 transition-transform duration-200 ${open ? "" : "-rotate-90"}`} /> : null}
      </button>
      {open && children ? (
        <div id={id} className="enter-glitch mb-2 ml-1 mt-1 border-l border-line pl-4">
          {children}
        </div>
      ) : null}
    </section>
  );
}

/** "Thinking", counting up while the model thinks; "Thought for 12s" once it has. */
function Thought({ m, reasoning }: { m: MessageRow & LiveActivity; reasoning: string }) {
  const live = !!(m.streaming && m.thinkingNow);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);
  const ms = m.content.thoughtMs ?? (m.thoughtSoFar ?? 0) + (m.thinkingSince ? Date.now() - m.thinkingSince : 0);
  const secs = Math.floor(ms / 1000);
  const label = live ? (secs ? `Thinking · ${secs}s` : "Thinking") : thoughtFor(ms);
  return (
    <Line testId="thought" label={label} live={live}>
      {reasoning ? (
        <div data-testid="reasoning" className="text-[15px] text-mute">
          <Markdown text={reasoning} streaming={m.streaming} />
        </div>
      ) : null}
    </Line>
  );
}

/** "Searching the web for …" while it searches; "Searched the web · 3 sources" afterwards. */
function Searched({ m, queries }: { m: MessageRow & LiveActivity; queries: string[] }) {
  const sources = m.content.sources ?? [];
  const searches = m.content.searches;
  const live = !!(m.streaming && m.searchingNow);
  const last = queries.at(-1);
  const label = live
    ? last
      ? `Searching the web for “${last}”`
      : "Searching the web"
    : `Searched the web${sources.length ? ` · ${sources.length} ${sources.length === 1 ? "source" : "sources"}` : ""}`;
  const hasMore = queries.length > 0 || sources.length > 0;
  return (
    <div data-testid={live ? "searching" : "sources"} aria-live={live ? "polite" : undefined} className="w-full">
      <Line testId="searched" label={label} live={live}>
        {hasMore && !live ? (
          <div className="flex flex-col gap-3 pb-1">
            {queries.length ? (
              <ul className="flex flex-col gap-1 text-[14px] text-mute">
                {queries.map((q) => (
                  <li key={q} className="break-words">
                    “{q}”
                  </li>
                ))}
              </ul>
            ) : null}
            {sources.length ? (
              <ol className="flex flex-col overflow-hidden rounded-2xl border border-line">
                {sources.map((s, i) => (
                  <li key={s.url} className="border-b border-line last:border-b-0">
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      referrerPolicy="no-referrer"
                      className="flex items-baseline gap-3 px-4 py-3 hover:bg-soft"
                    >
                      <span className="w-5 shrink-0 font-mono text-[12px] text-mute">{i + 1}</span>
                      <span className="flex min-w-0 flex-col">
                        <span className="break-words text-[15px] leading-snug">{s.title}</span>
                        <span className="truncate text-[13px] text-mute">{siteOf(s)}</span>
                      </span>
                    </a>
                  </li>
                ))}
              </ol>
            ) : null}
            {searches ? (
              <p className="text-[12px] text-mute">
                {searches} web {searches === 1 ? "search" : "searches"}, included in the cost below.
              </p>
            ) : null}
          </div>
        ) : null}
      </Line>
    </div>
  );
}

/** The reply exactly as the model wrote it, in Markdown, with a button to copy it. */
export function ViewSource({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <section data-testid="reply-source" aria-label="Reply source" className="enter-glitch overflow-hidden rounded-2xl border border-line">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2 font-mono text-[12px] text-mute">
        <span>markdown</span>
        <button
          type="button"
          className="press -mr-2 rounded-lg px-2 py-1 hover:text-fg"
          onClick={async () => {
            if (!(await copyText(text))) return;
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy source"}
        </button>
      </div>
      <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[13px] leading-relaxed">{text}</pre>
    </section>
  );
}

/** Copies text, falling back to a hidden text box where the clipboard API is refused. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const box = document.createElement("textarea");
    box.value = text;
    box.setAttribute("readonly", "");
    box.style.position = "fixed";
    box.style.opacity = "0";
    document.body.appendChild(box);
    box.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      box.remove();
    }
  }
}
