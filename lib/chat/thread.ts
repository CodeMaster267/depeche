/** Chat data shared by the server and the browser. */
import type { FileRef } from "./files";

/** A web page a reply's web search used. Only http(s) links are ever kept. */
export type Source = { url: string; title: string; domain?: string };

export type MessageRow = {
  id: string;
  chat_id: string;
  parent_id: string | null;
  role: "user" | "assistant" | "system";
  content: {
    text?: string;
    files?: FileRef[];
    notice?: string;
    error?: string;
    cost?: number;
    /** Pages the reply's web search found or cited, in the order they were cited. */
    sources?: Source[];
    /** How many web searches the reply ran (each one has a fee, included in cost). */
    searches?: number;
    /** Google's "Search suggestions" chips (its own HTML), shown in a sandbox as Google requires. */
    suggestions?: string;
    /** Set on a deep research report: what was researched. */
    research?: { title: string; questions: string[]; sources: number };
    /** On a question: the part of an earlier answer it asks about (selected by the person). */
    quote?: string;
    /** On a reply: questions the person might ask next, shown as buttons under the newest answer. */
    followups?: string[];
    /** On a reply: the tokens it used (estimated when the reply was stopped). */
    /** Tokens used; `cached` is the part of the input read back from the provider's prompt cache. */
    usage?: { input: number; output: number; cached?: number; estimated?: boolean };
    /** The model's reasoning, or its provider's summary of it, shown collapsed above the reply. */
    reasoning?: string;
    /** How long the model thought, in milliseconds. */
    thoughtMs?: number;
    /** What the reply searched the web for. */
    queries?: string[];
    /** What the reply looked up in earlier messages of this chat. */
    lookups?: string[];
    /** Files the reply read (those sent with the question). */
    read?: string[];
    /** Set when two or three models answered the same question side by side (see lib/chat/compare.ts). */
    compare?: { id: string; slot: number };
  };
  status: "pending" | "streaming" | "completed" | "failed" | "stopped";
  model: string | null;
  created_at: string;
  /** A memory this reply suggested that the person hasn't kept or dismissed yet. */
  memory?: { id: string; content: string };
};

export type ChatRow = {
  id: string;
  title: string;
  model: string | null;
  pinned: boolean;
  updated_at: string;
  /** Auto-compaction for this chat ("auto" unless turned off). Only loaded for the open chat. */
  compaction?: "auto" | "off";
  /** Set while the chat is archived: out of the list until restored or written in. */
  archived_at?: string | null;
  /** Set on chats brought in from another app's export. */
  imported_from?: "chatgpt" | "claude" | "gemini" | null;
  created_at?: string;
};

/**
 * Messages are never edited or deleted. A regenerated reply is a new message with the same parent,
 * and an edited message is a new message beside the original (same parent), so a chat is a tree.
 * The conversation shown is one path through it: by default the one ending at the newest message.
 */
export function activePath<T extends MessageRow>(messages: T[]): T[] {
  if (!messages.length) return [];
  const newest = messages.reduce((a, b) => (b.created_at > a.created_at ? b : a));
  return pathTo(messages, newest.id);
}

/** The conversation from the first message down to `leafId`. */
export function pathTo<T extends MessageRow>(messages: T[], leafId: string | null): T[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const path: T[] = [];
  for (let m = leafId ? byId.get(leafId) : undefined; m; m = m.parent_id ? byId.get(m.parent_id) : undefined) {
    path.push(m);
    if (path.length > messages.length) break; // a cycle would be a bug; never loop forever
  }
  return path.reverse();
}

const byTime = (a: MessageRow, b: MessageRow) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0);

/** The newest message at or below `id`: where the conversation goes on from there. */
export function latestLeaf<T extends MessageRow>(messages: T[], id: string): string {
  const children = new Map<string, T[]>();
  for (const m of messages) if (m.parent_id) children.set(m.parent_id, [...(children.get(m.parent_id) ?? []), m]);
  let at = id;
  for (let i = 0; i <= messages.length; i++) {
    const next = children.get(at);
    if (!next?.length) break;
    at = next.reduce((a, b) => (byTime(b, a) > 0 ? b : a)).id;
  }
  return at;
}

/** Every version of a message (itself, its edits or its regenerations), oldest first. */
export function versionsOf<T extends MessageRow>(messages: T[], m: T): T[] {
  return messages.filter((x) => x.parent_id === m.parent_id && x.role === m.role).sort(byTime);
}

/** A short title from the first message: the first line, cut at a word boundary. */
export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0].replace(/\s+/g, " ");
  if (line.length <= 60) return line || "New chat";
  const cut = line.slice(0, 60);
  return (cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 60) + "…").trim();
}

export const MAX_MESSAGE_CHARS = 100_000;
