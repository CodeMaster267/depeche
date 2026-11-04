import type { FileRef } from "@/lib/chat/files";

/**
 * Small pieces of the message box that don't need React: where a chat's unsent draft is kept on
 * this device, and the queue of messages typed while a reply is still being written.
 */

/** Unsent text is kept on this device only, per person and per chat ("new" for a new chat). */
export function draftKey(userId: string, chatId: string | null): string {
  return `depeche:draft:${userId}:${chatId ?? "new"}`;
}

export function readDraft(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(key: string, text: string) {
  try {
    if (text.trim()) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch {
    // Private browsing can block storage; the draft just isn't kept.
  }
}

/** Removes every draft kept on this device, used when signing out. */
export function clearDrafts() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith("depeche:draft:")) localStorage.removeItem(k);
    }
  } catch {
    // Nothing to clear.
  }
}

/**
 * A message typed while a reply was still being written. `extras` is anything else the send
 * carries in the /api/chat body (for example a quoted bit of an answer).
 */
export type Queued = { id: string; text: string; files: FileRef[]; extras?: Record<string, unknown> };

export const MAX_QUEUED = 5;

/**
 * What to send once a reply ends. Queued messages go one at a time, and only after a reply that
 * finished: if it was stopped or failed they wait, so the person can decide.
 */
export function nextQueued(queue: readonly Queued[], ended: "completed" | "stopped" | "failed"): Queued | undefined {
  return ended === "completed" ? queue[0] : undefined;
}
