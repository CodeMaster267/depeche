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
  const storage = supabaseAdmin().storage.from(UPLOAD_BUCKET);
  const own = (files ?? []).filter((f) => isFileRef(f, ownerId));
  let room = PROJECT_TEXT_CHARS;
  const parts: string[] = [];
  for (const f of own.filter((x) => readAsText(x.mime))) {
    const name = f.name.replace(/"/g, "'");
    if (room <= 0) {
      parts.push(`[Project file "${name}" is too long to include as well.]`);
      continue;
    }
    const { data: blob } = await storage.download(f.path);
    const body = !blob
      ? null
      : f.mime === "text/plain"
        ? await blob.text()
        : await documentText(f.mime, new Uint8Array(await blob.arrayBuffer())).catch(() => null);
    if (body === null) {
      parts.push(`[Project file "${name}" couldn't be read.]`);
      continue;
    }
    const cut = body.slice(0, room);
    room -= cut.length;
    parts.push(`<file name="${name}">\n${cut || "(This file has no text in it.)"}${cut.length < body.length ? "\n[…the rest is cut off]" : ""}\n</file>`);
  }
  return {
    name: project.name,
    instructions: project.instructions.trim(),
    text: parts.join("\n\n"),
    binaries: own.filter((x) => !readAsText(x.mime)),
  };
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
