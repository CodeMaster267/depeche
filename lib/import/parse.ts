/**
 * Reads the chat exports of other AI apps into Depeche's shape. Pure functions over the export's
 * JSON, so they run in the browser and in tests. Export text is the person's own data, but it is
 * treated as untrusted: only text is kept (never HTML), and every field is checked.
 */
import { finishChat, isoDate, type ImportedChat, type ImportedMessage } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Which app an export's chat list came from, judged by its shape. */
export function detectSource(data: unknown): "chatgpt" | "claude" | "gemini" | null {
  if (!Array.isArray(data)) return null;
  const sample = data.find(isObj);
  if (!sample) return null;
  if (isObj(sample.mapping)) return "chatgpt";
  if (Array.isArray(sample.chat_messages)) return "claude";
  if ("header" in sample && "time" in sample && "title" in sample) return "gemini";
  return null;
}

// ChatGPT -------------------------------------------------------------------------------------

/** ChatGPT's citation markers (private-use characters U+E200 to U+E2FF) and old-style
 * "[1 dagger source]" references in lenticular brackets. Built from code points to keep the source plain. */
const ch = (n: number) => String.fromCharCode(n);
const CITE = new RegExp(`[ \\t]*${ch(0xe200)}[^${ch(0xe201)}]*${ch(0xe201)}`, "g");
const OLD_CITE = new RegExp(`[ \\t]*${ch(0x3010)}\\d+(?::\\d+)?${ch(0x2020)}[^${ch(0x3011)}]*${ch(0x3011)}`, "g");
const PRIVATE_USE = new RegExp(`[${ch(0xe200)}-${ch(0xe2ff)}]`, "g");

function stripChatGptMarkers(text: string): string {
  return text.replace(CITE, "").replace(OLD_CITE, "").replace(PRIVATE_USE, "");
}

function chatGptText(content: unknown): string {
  if (!isObj(content)) return "";
  const type = str(content.content_type);
  if (type === "text" || type === "multimodal_text") {
    const parts = Array.isArray(content.parts) ? content.parts : [];
    return parts
      .map((p) => {
        if (typeof p === "string") return p;
        if (!isObj(p)) return "";
        if (p.content_type === "audio_transcription") return str(p.text);
        if (p.content_type === "image_asset_pointer") return "[Image not imported]";
        if (typeof p.content_type === "string" && p.content_type.includes("audio")) return "";
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return ""; // code run by tools, thoughts, browsing results, custom instructions: not shown
}

export function fromChatGpt(data: unknown[]): ImportedChat[] {
  const out: ImportedChat[] = [];
  for (const conv of data) {
    if (!isObj(conv) || !isObj(conv.mapping)) continue;
    const mapping = conv.mapping as Record<string, Obj>;
    // The conversation as last shown: from the current message back to the start.
    let node = str(conv.current_node);
    if (!mapping[node]) {
      const leaves = Object.values(mapping).filter((n) => isObj(n) && !(Array.isArray(n.children) && n.children.length));
      const time = (n: Obj) => (isObj(n.message) && typeof n.message.create_time === "number" ? n.message.create_time : 0);
      leaves.sort((a, b) => time(b) - time(a));
      node = str(leaves[0]?.id);
    }
    const path: Obj[] = [];
    const seen = new Set<string>();
    while (node && mapping[node] && !seen.has(node)) {
      seen.add(node);
      path.push(mapping[node]);
      node = str(mapping[node].parent);
    }
    path.reverse();

    const messages: ImportedMessage[] = [];
    for (const n of path) {
      const m = n.message;
      if (!isObj(m) || !isObj(m.author)) continue;
      const role = m.author.role;
      if (role !== "user" && role !== "assistant") continue;
      const meta = isObj(m.metadata) ? m.metadata : {};
      if (meta.is_visually_hidden_from_conversation) continue;
      if (m.recipient && m.recipient !== "all") continue; // a call to one of ChatGPT's tools
      const text = stripChatGptMarkers(chatGptText(m.content));
      if (!text.trim()) continue;
      messages.push({
        role,
        text,
        created_at: isoDate(m.create_time) ?? "",
        model: role === "assistant" ? str(meta.model_slug) || str(conv.default_model_slug) || "ChatGPT" : null,
      });
    }
    const chat = finishChat({
      source: "chatgpt",
      key: str(conv.conversation_id) || str(conv.id) || `${str(conv.title)}@${String(conv.create_time)}`,
      title: str(conv.title) || "ChatGPT chat",
      created_at: isoDate(conv.create_time),
      updated_at: isoDate(conv.update_time),
      messages,
    });
    if (chat) out.push(chat);
  }
  return out;
}

// Claude --------------------------------------------------------------------------------------

function claudeText(m: Obj): string {
  let text = "";
  if (Array.isArray(m.content) && m.content.length) {
    text = m.content
      .filter((b): b is Obj => isObj(b) && b.type === "text")
      .map((b) => str(b.text))
      .filter(Boolean)
      .join("\n\n");
  }
  if (!text.trim()) text = str(m.text);
  const names = [
    ...(Array.isArray(m.attachments) ? m.attachments : []),
    ...(Array.isArray(m.files) ? m.files : []),
  ]
    .map((f) => (isObj(f) ? str(f.file_name) : ""))
    .filter(Boolean);
  if (names.length) text += `\n\n[Attached: ${[...new Set(names)].join(", ")}]`;
  return text;
}

export function fromClaude(data: unknown[]): ImportedChat[] {
  const out: ImportedChat[] = [];
  for (const conv of data) {
    if (!isObj(conv) || !Array.isArray(conv.chat_messages)) continue;
    let list = conv.chat_messages.filter(isObj);
    // Newer exports keep every branch: follow the newest message back to the start.
    if (list.length && list.every((m) => "parent_message_uuid" in m)) {
      const byId = new Map(list.map((m) => [str(m.uuid), m]));
      const newest = list.reduce((a, b) => (str(b.created_at) > str(a.created_at) ? b : a));
      const path: Obj[] = [];
      const seen = new Set<string>();
      for (let m: Obj | undefined = newest; m && !seen.has(str(m.uuid)); m = byId.get(str(m.parent_message_uuid))) {
        seen.add(str(m.uuid));
        path.push(m);
      }
      list = path.reverse();
    }
    const messages: ImportedMessage[] = list.flatMap((m): ImportedMessage[] => {
      const role = m.sender === "human" ? "user" : m.sender === "assistant" ? "assistant" : null;
      if (!role) return [];
      return [{ role, text: claudeText(m), created_at: isoDate(m.created_at) ?? "", model: role === "assistant" ? "Claude" : null }];
    });
    const chat = finishChat({
      source: "claude",
      key: str(conv.uuid) || `${str(conv.name)}@${str(conv.created_at)}`,
      title: str(conv.name) || "Claude chat",
      created_at: isoDate(conv.created_at),
      updated_at: isoDate(conv.updated_at),
      messages,
    });
    if (chat) out.push(chat);
  }
  return out;
}

// Gemini (Google Takeout, "My Activity" in JSON) ----------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Plain text (Markdown-ish) from Takeout's reply HTML. Nothing from it is ever run or rendered as HTML. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code: string) => "\n```\n" + code.replace(/<[^>]+>/g, "") + "\n```\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<h([1-6])[^>]*>/gi, (_, n: string) => "\n\n" + "#".repeat(Number(n)) + " ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|h[1-6]|ul|ol|table|tr|blockquote)>/gi, "\n\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
      }
      return ENTITIES[e.toLowerCase()] ?? whole;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A new Gemini chat starts after this long without a prompt (Takeout keeps no chat ids). */
const GEMINI_GAP_MS = 30 * 60 * 1000;

export function fromGemini(data: unknown[]): ImportedChat[] {
  type Turn = { at: string; prompt: string; reply: string };
  const turns: Turn[] = [];
  for (const e of data) {
    if (!isObj(e)) continue;
    const title = str(e.title);
    const m = /^Prompted\s+([\s\S]+)$/.exec(title);
    const at = isoDate(e.time);
    if (!m || !at) continue;
    const html = Array.isArray(e.safeHtmlItem) ? e.safeHtmlItem.map((h) => (isObj(h) ? str(h.html) : "")).join("\n") : "";
    turns.push({ at, prompt: m[1], reply: htmlToText(html) });
  }
  turns.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const groups: Turn[][] = [];
  for (const t of turns) {
    const g = groups[groups.length - 1];
    if (g && new Date(t.at).getTime() - new Date(g[g.length - 1].at).getTime() <= GEMINI_GAP_MS) g.push(t);
    else groups.push([t]);
  }
  const out: ImportedChat[] = [];
  for (const g of groups) {
    const messages: ImportedMessage[] = g.flatMap((t) => [
      { role: "user" as const, text: t.prompt, created_at: t.at, model: null },
      ...(t.reply ? [{ role: "assistant" as const, text: t.reply, created_at: t.at, model: "Gemini" }] : []),
    ]);
    const firstLine = g[0].prompt.trim().split("\n")[0].replace(/\s+/g, " ");
    const chat = finishChat({
      source: "gemini",
      key: g[0].at,
      title: firstLine.length > 60 ? firstLine.slice(0, 59).trimEnd() + "…" : firstLine,
      created_at: g[0].at,
      updated_at: g[g.length - 1].at,
      messages,
    });
    if (chat) out.push(chat);
  }
  return out;
}

export function parseExport(data: unknown): { source: "chatgpt" | "claude" | "gemini"; chats: ImportedChat[] } | null {
  const source = detectSource(data);
  if (!source || !Array.isArray(data)) return null;
  const chats = source === "chatgpt" ? fromChatGpt(data) : source === "claude" ? fromClaude(data) : fromGemini(data);
  return { source, chats };
}
