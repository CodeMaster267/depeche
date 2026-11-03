"use client";

import { memo, useState } from "react";
import type { Source } from "@/lib/chat/thread";

/** The site a source is on, for showing next to its title. Google's links go through a redirect. */
export function siteOf(s: Source): string {
  if (s.domain) return s.domain.replace(/^www\./, "");
  try {
    return new URL(s.url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Shown while a reply is searching, before (or between) its text. */
export function Searching({ queries }: { queries: string[] }) {
  const last = queries.at(-1);
  return (
    <p data-testid="searching" className="flex items-center gap-2 text-[15px] text-mute" aria-live="polite">
      <span className="stream-cursor shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{last ? `Searching the web for “${last}”` : "Searching the web"}</span>
    </p>
  );
}

/**
 * The pages a reply's search used: a compact row of sites that opens into a numbered list. The
 * numbers match the [1] links inside the reply.
 */
export function Sources({ sources, searches }: { sources: Source[]; searches?: number }) {
  const [open, setOpen] = useState(false);
  const sites = [...new Set(sources.map(siteOf).filter(Boolean))];
  return (
    <section data-testid="sources" className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="press flex max-w-full items-center gap-2 self-start rounded-full border border-line px-3.5 py-1.5 text-[14px] hover:border-fg"
      >
        <span className="shrink-0 whitespace-nowrap font-medium">
          {sources.length} {sources.length === 1 ? "source" : "sources"}
        </span>
        <span className="min-w-0 truncate text-mute">{sites.slice(0, 3).join(" · ")}</span>
      </button>
      {open ? (
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
          {searches ? (
            <li className="px-4 py-2 text-[12px] text-mute">
              {searches} web {searches === 1 ? "search" : "searches"}, included in the cost below.
            </li>
          ) : null}
        </ol>
      ) : null}
    </section>
  );
}

/**
 * Google asks that grounded answers show its "Search suggestions" exactly as it sends them. The
 * HTML is Google's, so it runs in a sandbox with no scripts and no access to the app; links open
 * in a new tab.
 */
export const SearchSuggestions = memo(function SearchSuggestions({ html }: { html: string }) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><base target="_blank"><style>:root{color-scheme:light dark}html,body{margin:0;background:transparent}</style></head><body>${html}</body></html>`;
  return (
    <iframe
      title="Search suggestions from Google"
      data-testid="search-suggestions"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={doc}
      className="h-[64px] w-full rounded-2xl border-0"
    />
  );
});
