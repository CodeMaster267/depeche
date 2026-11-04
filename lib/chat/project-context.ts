import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { documentText } from "@/lib/docs/read";
import { UPLOAD_BUCKET, isFileRef, readAsText, type FileRef } from "./files";

/** Text from a project's files sent with every message in it: about 50k tokens at most. */
export const PROJECT_TEXT_CHARS = 200_000;

export type ProjectContext = {
  name: string;
  instructions: string;
  /** The project's Word, Excel, PowerPoint and text files, read out, for the system prompt. */
  text: string;
  /** Its photos and PDFs, sent to the model as files with the conversation. */
  binaries: FileRef[];
};

/** Reads the Word, Excel, PowerPoint and text files out, and lists the photos and PDFs to attach. */
async function readFiles(files: FileRef[], ownerId: string, label: string, room: number) {
  const storage = supabaseAdmin().storage.from(UPLOAD_BUCKET);
  // Only ever files in the maker's own folder, whatever a row says.
  const own = files.filter((f) => isFileRef(f, ownerId));
  const parts: string[] = [];
  for (const f of own.filter((x) => readAsText(x.mime))) {
    const name = f.name.replace(/"/g, "'");
    if (room <= 0) {
      parts.push(`[${label} file "${name}" is too long to include as well.]`);
      continue;
    }
    const { data: blob } = await storage.download(f.path);
    const body = !blob
      ? null
      : f.mime === "text/plain"
        ? await blob.text()
        : await documentText(f.mime, new Uint8Array(await blob.arrayBuffer())).catch(() => null);
    if (body === null) {
      parts.push(`[${label} file "${name}" couldn't be read.]`);
      continue;
    }
    const cut = body.slice(0, room);
    room -= cut.length;
    parts.push(`<file name="${name}">\n${cut || "(This file has no text in it.)"}${cut.length < body.length ? "\n[…the rest is cut off]" : ""}\n</file>`);
  }
  return { text: parts.join("\n\n"), binaries: own.filter((x) => !readAsText(x.mime)) };
}

/**
 * What a chat in a project brings to the model: the project's instructions and files. Read as the
 * person (row-level security), and only ever files in their own folder.
 */
export async function projectContext(db: SupabaseClient, ownerId: string, projectId: string): Promise<ProjectContext | null> {
  const [{ data: project }, { data: files }] = await Promise.all([
    db.from("projects").select("name, instructions").eq("id", projectId).eq("owner_id", ownerId).maybeSingle<{ name: string; instructions: string }>(),
    db
      .from("project_files")
      .select("path, name, mime, size")
      .eq("project_id", projectId)
      .eq("owner_id", ownerId)
      .order("created_at")
      .returns<FileRef[]>(),
  ]);
  if (!project) return null;
  const read = await readFiles(files ?? [], ownerId, "Project", PROJECT_TEXT_CHARS);
  return { name: project.name, instructions: project.instructions.trim(), ...read };
}

export type AssistantContext = ProjectContext & { model: string | null };

/**
 * A saved assistant's instructions and files, if the person can see it (their own, or shared with
 * their family). Read as the person, so row-level security decides; the files are read from the
 * maker's folder by the server, since nobody else can open them.
 */
export async function assistantContext(db: SupabaseClient, assistantId: string): Promise<AssistantContext | null> {
  const { data: a } = await db
    .from("assistants")
    .select("owner_id, name, instructions, model")
    .eq("id", assistantId)
    .maybeSingle<{ owner_id: string; name: string; instructions: string; model: string | null }>();
  if (!a) return null;
  const { data: files } = await db
    .from("assistant_files")
    .select("path, name, mime, size")
    .eq("assistant_id", assistantId)
    .eq("owner_id", a.owner_id)
    .order("created_at")
    .returns<FileRef[]>();
  const read = await readFiles(files ?? [], a.owner_id, "Assistant", PROJECT_TEXT_CHARS);
  return { name: a.name, instructions: a.instructions.trim(), model: a.model, ...read };
}

/** The part of the system prompt that sets up a saved assistant. */
export function assistantInstructions(a: AssistantContext): string {
  const lines = [`In this chat you are ${JSON.stringify(a.name)}, an assistant someone in the family set up.`];
  if (a.instructions) lines.push(`How to behave as this assistant (follow it unless the person asks otherwise):\n<assistant_instructions>\n${a.instructions}\n</assistant_instructions>`);
  const names = a.binaries.map((f) => JSON.stringify(f.name));
  if (a.text || names.length) {
    lines.push("The assistant's files are its reference material; use them when relevant." + (names.length ? ` Attached with the conversation: ${names.join(", ")}.` : ""));
  }
  if (a.text) lines.push(`<assistant_files>\n${a.text}\n</assistant_files>`);
  return lines.join("\n\n");
}

/** The part of the system prompt that describes the project. */
export function projectInstructions(p: ProjectContext): string {
  const lines = [`This chat is part of ${JSON.stringify(p.name)}, a project the person set up to group related chats.`];
  if (p.instructions) lines.push(`Their instructions for every chat in this project (follow them unless they ask otherwise in the chat):\n<project_instructions>\n${p.instructions}\n</project_instructions>`);
  const names = p.binaries.map((f) => JSON.stringify(f.name));
  if (p.text || names.length) {
    lines.push(
      "The project's files are reference material for these chats; use them when relevant." +
        (names.length ? ` Attached with the conversation: ${names.join(", ")}.` : ""),
    );
  }
  if (p.text) lines.push(`<project_files>\n${p.text}\n</project_files>`);
  return lines.join("\n\n");
}
