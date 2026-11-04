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
    /** On a question: the part of an earlier answer it asks about (selected by the person). */
    quote?: string;
    /** On a reply: questions the person might ask next, shown as buttons under the newest answer. */
    followups?: string[];
    /** On a reply: the tokens it used (estimated when the reply was stopped). */
    usage?: { input: number; output: number; estimated?: boolean };
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
  };
  status: "pending" | "streaming" | "completed" | "failed" | "stopped";
  model: string | null;
  created_at: string;
  /** A memory this reply suggested that the person hasn't kept or dismissed yet. */
  memory?: { id: string; content: string };
};

export type ChatRow = { id: string; title: string; model: string | null; pinned: boolean; updated_at: string };

/**
 * Messages are never edited or deleted: a regenerated reply is a new message with the same parent.
 * The conversation shown is the path from the newest message back to the first.
 */
export function activePath(messages: MessageRow[]): MessageRow[] {
  if (!messages.length) return [];
  const byId = new Map(messages.map((m) => [m.id, m]));
  const newest = messages.reduce((a, b) => (b.created_at > a.created_at ? b : a));
  const path: MessageRow[] = [];
  for (let m: MessageRow | undefined = newest; m; m = m.parent_id ? byId.get(m.parent_id) : undefined) {
    path.push(m);
    if (path.length > messages.length) break; // a cycle would be a bug; never loop forever
  }
  return path.reverse();
}

/** A short title from the first message: the first line, cut at a word boundary. */
export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0].replace(/\s+/g, " ");
  if (line.length <= 60) return line || "New chat";
  const cut = line.slice(0, 60);
  return (cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 60) + "…").trim();
}

export const MAX_MESSAGE_CHARS = 100_000;
