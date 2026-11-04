"use client";

import { memo } from "react";
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
