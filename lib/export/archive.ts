/**
 * "Download everything": turns a person's own data into a zip they can open anywhere.
 *
 * Pure functions only, so the same code runs in the browser (which builds the zip, keeping it off
 * Vercel's 4.5 MB response limit) and in tests. Fetching the data lives in `collect.ts`.
 */
import { zipSync, strToU8, type Zippable } from "fflate";
import { activePath, type MessageRow } from "@/lib/chat/thread";
import type { FileRef } from "@/lib/chat/files";

export type ExportChat = {
  id: string;
  title: string;
  model: string | null;
  pinned: boolean;
  archived_at: string | null;
  project_id?: string | null;
  assistant_id?: string | null;
  created_at: string;
  updated_at: string;
};

export type ExportMessage = Omit<MessageRow, "memory"> & { provider?: string | null };

export type ExportMemory = { id: string; content: string; status: string; created_at: string; updated_at: string };

export type ExportUsage = {
  created_at: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: string | number;
  message_id: string | null;
};

export type ExportData = {
  exportedAt: string;
  profile: Record<string, unknown>;
  chats: ExportChat[];
  messages: ExportMessage[];
  memories: ExportMemory[];
  usage: ExportUsage[];
  /** Your projects (folders) with their instructions and file lists; chats name theirs by project_id. */
  projects?: ExportKept[];
  /** The assistants you made, with their instructions and file lists. */
  assistants?: ExportKept[];
  /** "About you" and "How should Depeche answer", when the person has written them. */
  instructions?: { about_me: string; answer_style: string; enabled: boolean; updated_at: string } | null;
};

/** A project or saved assistant, as exported. */
export type ExportKept = Record<string, unknown> & { files: FileRef[] };

/** A downloaded upload, or null when it has already been deleted (files go after 3 idle days). */
export type FetchedFile = { ref: FileRef; data: Uint8Array | null };

/** A name safe on Windows, macOS and iPhone Files: no slashes or reserved characters. */
export function safeName(name: string, fallback = "untitled"): string {
  const clean = name
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 80)
    .trim();
  return clean || fallback;
}

/** Hands out names, adding " (2)", " (3)"… so nothing in a folder overwrites anything else. */
export function uniqueNamer() {
  const used = new Set<string>();
  return (name: string): string => {
    const dot = name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    let candidate = name;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
    used.add(candidate.toLowerCase());
    return candidate;
  };
}

const day = (iso: string) => iso.slice(0, 10);
const stamp = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/**
 * One chat as Markdown: the conversation as it was last shown. Earlier versions of edited or
 * regenerated messages are kept in chats.json, not here.
 */
export function chatMarkdown(chat: Pick<ExportChat, "title" | "created_at">, messages: ExportMessage[], fileLinks?: Map<string, string>): string {
  const out: string[] = [`# ${chat.title}`, "", `Started ${stamp(chat.created_at)}`, ""];
  for (const m of activePath(messages as MessageRow[])) {
    if (m.role === "system") continue;
    const who = m.role === "user" ? "You" : m.model ? `Assistant (${m.model})` : "Assistant";
    out.push("---", "", `**${who}** · ${stamp(m.created_at)}`, "");
    const text = m.content.text?.trim();
    if (text) out.push(text, "");
    if (m.status === "failed" || m.content.error) out.push(`_This reply failed${m.content.error ? `: ${m.content.error}` : "."}_`, "");
    else if (m.status === "stopped") out.push("_Stopped before it finished._", "");
    const files = m.content.files ?? [];
    if (files.length) {
      out.push("Attached:");
      for (const f of files) {
        const link = fileLinks?.get(f.path);
        out.push(link ? `- [${f.name}](${encodeURI(link)})` : fileLinks ? `- ${f.name} (no longer stored)` : `- ${f.name}`);
      }
      out.push("");
    }
    const sources = m.content.sources ?? [];
    if (sources.length) {
      out.push("Sources:");
      for (const s of sources) out.push(`- [${s.title || s.domain || s.url}](${s.url})`);
      out.push("");
    }
  }
  return out.join("\n").trimEnd() + "\n";
}

export function memoriesMarkdown(memories: ExportMemory[]): string {
  const groups: [string, string][] = [
    ["active", "Remembered"],
    ["suggested", "Suggested, not answered yet"],
    ["archived", "Archived"],
    ["rejected", "Dismissed"],
  ];
  const out = ["# Memories", ""];
  for (const [status, heading] of groups) {
    const list = memories.filter((m) => m.status === status);
    if (!list.length) continue;
    out.push(`## ${heading}`, "", ...list.map((m) => `- ${m.content.replace(/\s*\n\s*/g, " ")}`), "");
  }
  if (out.length === 2) out.push("No memories.", "");
  return out.join("\n");
}

export function instructionsMarkdown(p: NonNullable<ExportData["instructions"]>): string {
  const out = ["# Personal instructions", "", p.enabled ? "Used in every chat." : "Paused (not used in chats).", ""];
  out.push("## About you", "", p.about_me.trim() || "Nothing written.", "");
  out.push("## How should Depeche answer?", "", p.answer_style.trim() || "Nothing written.", "");
  return out.join("\n");
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function usageCsv(usage: ExportUsage[]): string {
  const cols = ["created_at", "provider", "model", "input_tokens", "output_tokens", "cost_usd", "message_id"] as const;
  return [cols.join(","), ...usage.map((u) => cols.map((c) => csvCell(u[c])).join(","))].join("\n") + "\n";
}

const README = (exportedAt: string) => `Depeche export, made ${stamp(exportedAt)}

Everything here is yours and only yours: no one else's chats are in it.

  chats/          each chat as a Markdown file you can read in any app
  files/          files you attached that Depeche still had (files go after 3 unused days)
  chats.json      every chat and every message, including earlier versions of edited replies
  memories.md     what Depeche remembers about you
  memories.json   the same, with dates and status
  instructions.md your personal instructions (About you, How should Depeche answer), if any
  usage.csv       what each reply cost (estimates, in US dollars)
  profile.json    your name, username and settings
`;

/** Folder-friendly name for a chat: date first so the list sorts by time. */
function chatFileStem(chat: ExportChat): string {
  return `${day(chat.created_at)} ${safeName(chat.title, "Chat")}`;
}

/** Every file in the export, by path inside the zip. */
export function exportEntries(data: ExportData, files: FetchedFile[]): Record<string, Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  const json = (v: unknown) => strToU8(JSON.stringify(v, null, 2) + "\n");

  // Files first, so chat Markdown can link to where each one landed.
  const links = new Map<string, string>();
  const fileNamer = uniqueNamer();
  for (const f of files) {
    if (!f.data || links.has(f.ref.path)) continue;
    const name = fileNamer(safeName(f.ref.name, "file"));
    links.set(f.ref.path, `../files/${name}`);
    entries[`files/${name}`] = f.data;
  }

  const byChat = new Map<string, ExportMessage[]>();
  for (const m of data.messages) byChat.set(m.chat_id, [...(byChat.get(m.chat_id) ?? []), m]);

  const chatNamer = uniqueNamer();
  for (const chat of data.chats) {
    entries[`chats/${chatNamer(chatFileStem(chat) + ".md")}`] = strToU8(chatMarkdown(chat, byChat.get(chat.id) ?? [], links));
  }

  entries["README.txt"] = strToU8(README(data.exportedAt));
  entries["profile.json"] = json(data.profile);
  entries["chats.json"] = json(data.chats.map((c) => ({ ...c, messages: byChat.get(c.id) ?? [] })));
  entries["memories.json"] = json(data.memories);
  entries["memories.md"] = strToU8(memoriesMarkdown(data.memories));
  if (data.instructions) entries["instructions.md"] = strToU8(instructionsMarkdown(data.instructions));
  entries["usage.csv"] = strToU8(usageCsv(data.usage));
  const withLinks = (list: ExportKept[]) => list.map((x) => ({ ...x, files: x.files.map((f) => ({ ...f, saved_as: links.get(f.path)?.replace("../", "") ?? null })) }));
  if (data.projects?.length) entries["projects.json"] = json(withLinks(data.projects));
  if (data.assistants?.length) entries["assistants.json"] = json(withLinks(data.assistants));
  return entries;
}

/** Already-compressed formats are stored as they are; text is squeezed. */
export function zipEntries(entries: Record<string, Uint8Array>, folder: string): Uint8Array {
  const zippable: Zippable = {};
  for (const [path, data] of Object.entries(entries)) {
    zippable[`${folder}/${path}`] = [data, { level: /\.(jpe?g|png|gif|webp|pdf)$/i.test(path) ? 0 : 6 }];
  }
  return zipSync(zippable);
}

export function exportFileName(exportedAt: string): string {
  return `depeche-export-${day(exportedAt)}`;
}

/** File name for one chat's Markdown download. */
export function chatFileName(chat: ExportChat): string {
  return chatFileStem(chat) + ".md";
}
