/** Shared chats: what a share link shows. Used by the server (making a share) and the share page. */
import { activePath, type MessageRow, type Source } from "./thread";

/** One message in a shared chat. Attached files are named only, never their contents or location. */
export type SharedMessage = {
  role: "user" | "assistant";
  text: string;
  files?: { name: string; mime: string }[];
  sources?: Source[];
  model?: string;
};

/** A shared chat can hold at most this much text, so one share can't fill the database. */
export const MAX_SHARE_CHARS = 2_000_000;

/** A random, unguessable link token (32 bytes, base64url). */
export function shareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const isShareToken = (t: string) => /^[A-Za-z0-9_-]{32,64}$/.test(t);

/**
 * The conversation as the owner currently sees it, reduced to what a reader needs: text, file
 * names, the web pages a reply cited and which model wrote it. Costs, errors, notices, Google's
 * search chips and anything not on the shown path are left out.
 */
export function snapshot(messages: MessageRow[]): SharedMessage[] {
  const out: SharedMessage[] = [];
  for (const m of activePath(messages)) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = m.content.text ?? "";
    const files = m.role === "user" ? (m.content.files ?? []).map((f) => ({ name: String(f.name).slice(0, 200), mime: String(f.mime) })) : [];
    if (!text.trim() && !files.length) continue;
    const msg: SharedMessage = { role: m.role, text };
    if (files.length) msg.files = files;
    if (m.role === "assistant") {
      const sources = (m.content.sources ?? []).filter((s) => /^https?:\/\//i.test(s.url)).slice(0, 30);
      if (sources.length) msg.sources = sources;
      if (m.model) msg.model = m.model;
    }
    out.push(msg);
  }
  return out;
}

export const snapshotChars = (messages: SharedMessage[]) => messages.reduce((n, m) => n + m.text.length, 0);
