"use server";

import { requireMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { findModel } from "@/lib/ai/models";
import { UPLOAD_BUCKET, isFileRef } from "@/lib/chat/files";
import {
  MAX_ASSISTANT_DESCRIPTION,
  MAX_ASSISTANT_FILES,
  MAX_ASSISTANT_INSTRUCTIONS,
  cleanAssistantName,
} from "@/lib/chat/assistants";
import type { ProjectFile } from "@/lib/chat/projects";

/**
 * Saved assistants. Everything runs with the person's own session: row-level security lets only
 * the maker change an assistant, and keeps sharing inside the maker's family.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AssistantInput = { name: string; description: string; instructions: string; model: string | null; shared: boolean };

/** Makes a new assistant (no id) or saves yours. Returns its id, or why it couldn't be saved. */
export async function saveAssistant(id: string | null, input: AssistantInput): Promise<{ id: string } | { error: string }> {
  const me = await requireMe();
  const name = cleanAssistantName(String(input.name ?? ""));
  if (!name) return { error: "Give it a name." };
  const row = {
    name,
    description: String(input.description ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_ASSISTANT_DESCRIPTION),
    instructions: String(input.instructions ?? "").trim().slice(0, MAX_ASSISTANT_INSTRUCTIONS),
    model: findModel(input.model) ? input.model : null,
    shared: input.shared === true,
    updated_at: new Date().toISOString(),
  };
  const db = await supabaseServer();
  if (id) {
    if (!UUID.test(id)) return { error: "That assistant doesn't exist." };
    const { data } = await db.from("assistants").update(row).eq("id", id).eq("owner_id", me.userId).select("id").maybeSingle<{ id: string }>();
    return data ?? { error: "Only the person who made this assistant can change it." };
  }
  // The family comes from the maker's profile (set by the database), never from here.
  const { data } = await db
    .from("assistants")
    .insert({ ...row, owner_id: me.userId, family_id: me.profile.family_id })
    .select("id")
    .single<{ id: string }>();
  return data ?? { error: "Couldn't save. Try again." };
}

export async function deleteAssistant(id: string) {
  const me = await requireMe();
  if (!UUID.test(id)) return;
  const db = await supabaseServer();
  const { data: files } = await db
    .from("assistant_files")
    .select("path")
    .eq("assistant_id", id)
    .eq("owner_id", me.userId)
    .returns<{ path: string }[]>();
  const paths = (files ?? []).map((f) => f.path).filter((p) => p.startsWith(`${me.userId}/`));
  if (paths.length) await db.storage.from(UPLOAD_BUCKET).remove(paths);
  await db.from("assistants").delete().eq("id", id).eq("owner_id", me.userId);
}

/** Keeps a file the browser already uploaded to the maker's own folder with their assistant. */
export async function addAssistantFile(id: string, file: unknown): Promise<ProjectFile | { error: string }> {
  const me = await requireMe();
  if (!UUID.test(id) || !isFileRef(file, me.userId)) return { error: "That file can't be added. Try again." };
  const db = await supabaseServer();
  const { count } = await db
    .from("assistant_files")
    .select("id", { count: "exact", head: true })
    .eq("assistant_id", id)
    .eq("owner_id", me.userId);
  if ((count ?? 0) >= MAX_ASSISTANT_FILES) {
    await db.storage.from(UPLOAD_BUCKET).remove([file.path]);
    return { error: `An assistant can hold up to ${MAX_ASSISTANT_FILES} files.` };
  }
  const { data } = await db
    .from("assistant_files")
    .insert({ assistant_id: id, owner_id: me.userId, path: file.path, name: file.name, mime: file.mime, size: file.size })
    .select("id, path, name, mime, size")
    .single<ProjectFile>();
  if (!data) {
    await db.storage.from(UPLOAD_BUCKET).remove([file.path]);
    return { error: "Couldn't add that file. Try again." };
  }
  return data;
}

export async function removeAssistantFile(fileId: string) {
  const me = await requireMe();
  if (!UUID.test(fileId)) return;
  const db = await supabaseServer();
  const { data } = await db
    .from("assistant_files")
    .delete()
    .eq("id", fileId)
    .eq("owner_id", me.userId)
    .select("path")
    .maybeSingle<{ path: string }>();
  if (data?.path.startsWith(`${me.userId}/`)) await db.storage.from(UPLOAD_BUCKET).remove([data.path]);
}
