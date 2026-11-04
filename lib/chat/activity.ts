/**
 * What a reply did besides writing: how long it thought, what it searched for, which files it
 * read. Shared by the server (which records it) and the browser (which shows it as short lines).
 */

/** Reasoning kept with a reply, at most. Longer reasoning keeps its start. */
export const MAX_REASONING_CHARS = 100_000;
/** Search queries kept with a reply, at most. */
export const MAX_QUERIES = 10;

/** "Thought for 12s", "Thought for 1m 5s", or "Thought for a moment" when it was under a second. */
export function thoughtFor(ms: number | undefined): string {
  if (!ms || ms < 1000) return "Thought for a moment";
  const s = Math.round(ms / 1000);
  if (s < 60) return `Thought for ${s}s`;
  const m = Math.floor(s / 60);
  return `Thought for ${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
}

/**
 * Times the reply's thinking: from the first reasoning it sends until it starts writing (or ends),
 * adding up separate spells of thinking, as Claude can think again after a search.
 */
export function thinkingClock(now: () => number = Date.now) {
  let total = 0;
  let since: number | null = null;
  return {
    thinking() {
      if (since === null) since = now();
    },
    stopped() {
      if (since !== null) total += now() - since;
      since = null;
    },
    get ms() {
      return total + (since !== null ? now() - since : 0);
    },
  };
}
