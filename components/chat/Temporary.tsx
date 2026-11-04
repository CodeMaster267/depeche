"use client";

import type { MessageRow } from "@/lib/chat/thread";
import type { FileRef } from "@/lib/chat/files";

/** One earlier turn of a temporary chat, sent back to the server with each new message. */
export type TemporaryTurn = { role: "user" | "assistant"; text: string; files?: FileRef[] };

/**
 * The conversation so far, as a temporary chat sends it (the server keeps none of it). Replies still
 * being written and failed replies are left out, as they are for saved chats.
 */
export function historyOf(messages: (MessageRow & { streaming?: boolean })[]): TemporaryTurn[] {
  return messages
    .filter((m) => (m.role === "user" || (m.role === "assistant" && m.status !== "failed")) && !m.streaming)
    .map((m) => ({
      role: m.role as TemporaryTurn["role"],
      text: m.content.text ?? "",
      ...(m.role === "user" && m.content.files?.length ? { files: m.content.files } : {}),
    }));
}

/** A speech bubble drawn with a dashed line: a chat that won't be kept. */
export const TemporaryIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3.5c-4.97 0-9 3.36-9 7.5 0 2.1 1.04 4 2.72 5.36L5 20.5l4.3-2.03c.86.2 1.76.3 2.7.3 4.97 0 9-3.35 9-7.5s-4.03-7.77-9-7.77Z" strokeDasharray="2.6 2.6" />
  </svg>
);

/**
 * Turns a new chat into a temporary one (and back). Shown in the header of an empty new chat; once
 * a temporary chat has messages it stays temporary, and New chat leaves it.
 */
export function TemporaryToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      aria-label="Temporary chat"
      title={on ? "Temporary chat: not saved, nothing remembered" : "Start a temporary chat"}
      className={`press flex h-10 min-w-10 shrink-0 items-center justify-center gap-1.5 rounded-full px-2 text-[14px] ${
        on ? "border border-fg text-fg" : "text-mute hover:text-fg"
      }`}
    >
      <TemporaryIcon />
      {on ? <span className="hidden sm:inline">Temporary</span> : null}
    </button>
  );
}
