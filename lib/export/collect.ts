/**
 * Gathers a person's own data in the browser, signed in as them, so row-level security decides
 * what can be read. Every query also names the person's own id: a family admin can read members'
 * chat titles and usage, and those must never end up in the admin's own export.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { UPLOAD_BUCKET, type FileRef } from "@/lib/chat/files";
import { chatFileName, chatMarkdown, type ExportCanvas, type ExportCanvasVersion, type ExportChat, type ExportData, type ExportMemory, type ExportMessage, type ExportUsage, type FetchedFile } from "./archive";

const PAGE = 1000; // Supabase returns at most this many rows per request

type Query<T> = (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

async function all<T>(query: Query<T>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

export type Progress = (step: string) => void;

export async function collectData(db: SupabaseClient, userId: string, extra: Record<string, unknown>, progress: Progress = () => {}): Promise<ExportData> {
  progress("Gathering your chats");
  const chats = await all<ExportChat>((a, b) =>
    db
      .from("chats")
      .select("id, title, model, pinned, archived_at, project_id, assistant_id, created_at, updated_at")
      .eq("owner_id", userId)
      .order("created_at")
      .order("id")
      .range(a, b),
  );
  const messages = await all<ExportMessage>((a, b) =>
    db
      .from("messages")
      .select("id, chat_id, parent_id, role, content, status, provider, model, created_at")
      .eq("owner_id", userId)
      .order("created_at")
      .order("id")
      .range(a, b),
  );
  progress("Gathering your memories");
  const memories = await all<ExportMemory>((a, b) =>
    db.from("memories").select("id, content, about, status, created_at, updated_at").eq("owner_id", userId).order("created_at").order("id").range(a, b),
  );
  const { data: instructions, error: instructionsError } = await db
    .from("personal_instructions")
    .select("about_me, answer_style, enabled, updated_at")
    .eq("owner_id", userId)
    .maybeSingle<NonNullable<ExportData["instructions"]>>();
  if (instructionsError) throw new Error(instructionsError.message);
  const usage = await all<ExportUsage>((a, b) =>
    db
      .from("usage_events")
      .select("created_at, provider, model, input_tokens, output_tokens, cost_usd, message_id")
      .eq("owner_id", userId)
      .order("created_at")
      .order("id")
      .range(a, b),
  );
  progress("Gathering your canvases");
  const canvases = await all<ExportCanvas>((a, b) =>
    db.from("canvases").select("id, chat_id, title, created_at, updated_at").eq("owner_id", userId).order("created_at").order("id").range(a, b),
  );
  const canvasVersions = canvases.length
    ? await all<ExportCanvasVersion>((a, b) =>
        db
          .from("canvas_versions")
          .select("canvas_id, content, author, message_id, created_at")
          .eq("owner_id", userId)
          .order("created_at")
          .order("id")
          .range(a, b),
      )
    : [];
  const { data: profile } = await db
    .from("profiles")
    .select("display_name, username, role, monthly_cap_usd, share_titles, keep_chats, last_model, created_at")
    .eq("id", userId)
    .maybeSingle();
  progress("Gathering your projects and assistants");
  const [{ data: projects }, { data: projectFiles }, { data: assistants }, { data: assistantFiles }] = await Promise.all([
    db.from("projects").select("id, name, instructions, created_at, updated_at").eq("owner_id", userId).order("created_at"),
    db.from("project_files").select("project_id, path, name, mime, size").eq("owner_id", userId).order("created_at"),
    db.from("assistants").select("id, name, description, instructions, model, shared, created_at, updated_at").eq("owner_id", userId).order("created_at"),
    db.from("assistant_files").select("assistant_id, path, name, mime, size").eq("owner_id", userId).order("created_at"),
  ]);
  const filesOf = (rows: Record<string, unknown>[] | null, key: string, id: unknown) =>
    (rows ?? []).filter((f) => f[key] === id).map(({ path, name, mime, size }) => ({ path, name, mime, size }) as FileRef);
  return {
    exportedAt: new Date().toISOString(),
    profile: { ...extra, ...(profile ?? {}) },
    chats,
    messages,
    memories,
    usage,
    instructions,
    canvases,
    canvasVersions,
    projects: (projects ?? []).map((p) => ({ ...p, files: filesOf(projectFiles, "project_id", p.id) })),
    assistants: (assistants ?? []).map((a) => ({ ...a, files: filesOf(assistantFiles, "assistant_id", a.id) })),
  };
}

/** The files the person's own messages point at, each downloaded once. Missing ones come back empty. */
export async function collectFiles(
  db: SupabaseClient,
  userId: string,
  messages: ExportMessage[],
  progress: Progress = () => {},
  kept: FileRef[] = [],
): Promise<FetchedFile[]> {
  const refs = new Map<string, FileRef>();
  // Files kept with your projects and assistants too.
  for (const f of kept) if (f.path.startsWith(`${userId}/`) && !refs.has(f.path)) refs.set(f.path, f);
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const f of m.content.files ?? []) if (f.path.startsWith(`${userId}/`) && !refs.has(f.path)) refs.set(f.path, f);
  }
  const out: FetchedFile[] = [];
  let i = 0;
  for (const ref of refs.values()) {
    progress(`Downloading files (${++i} of ${refs.size})`);
    const { data } = await db.storage.from(UPLOAD_BUCKET).download(ref.path);
    out.push({ ref, data: data ? new Uint8Array(await data.arrayBuffer()) : null });
  }
  return out;
}

/** One of your chats as a Markdown file. */
export async function downloadChat(db: SupabaseClient, userId: string, chatId: string): Promise<void> {
  const { data: chat, error } = await db
    .from("chats")
    .select("id, title, model, pinned, archived_at, created_at, updated_at")
    .eq("id", chatId)
    .eq("owner_id", userId)
    .single<ExportChat>();
  if (error || !chat) throw new Error("Chat not found");
  const messages = await all<ExportMessage>((a, b) =>
    db
      .from("messages")
      .select("id, chat_id, parent_id, role, content, status, provider, model, created_at")
      .eq("chat_id", chatId)
      .eq("owner_id", userId)
      .order("created_at")
      .order("id")
      .range(a, b),
  );
  saveBlob(new Blob([chatMarkdown(chat, messages)], { type: "text/markdown;charset=utf-8" }), chatFileName(chat));
}

/** Hands the browser a file to save. Works in Chrome, Safari and the iPhone home-screen app. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
