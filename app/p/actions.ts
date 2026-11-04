"use server";

import { requireMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { loadProject } from "@/lib/chat/load";
import { UPLOAD_BUCKET, isFileRef } from "@/lib/chat/files";
import { MAX_PROJECT_FILES, MAX_PROJECT_INSTRUCTIONS, cleanProjectName, type ProjectFile, type ProjectRow } from "@/lib/chat/projects";

/**
 * Projects: folders for your chats with their own instructions and files. Everything runs with the
 * person's own session, so row-level security keeps each project to its owner. The screen updates
 * itself straight away, so nothing here asks for the page to be redrawn (which would close the
 * chat list on a phone mid-task); every page loads fresh when opened.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function refreshProject(projectId: string) {
  return loadProject(await requireMe(), projectId);
}

export async function createProject(name: string): Promise<ProjectRow | null> {
  const me = await requireMe();
  const clean = cleanProjectName(name);
  if (!clean) return null;
  const { data } = await (await supabaseServer())
    .from("projects")
    .insert({ owner_id: me.userId, name: clean })
    .select("id, name, updated_at")
    .single<ProjectRow>();
  return data ?? null;
}

export async function renameProject(projectId: string, name: string) {
  const me = await requireMe();
  const clean = cleanProjectName(name);
  if (!clean || !UUID.test(projectId)) return;
  await (await supabaseServer())
    .from("projects")
    .update({ name: clean, updated_at: new Date().toISOString() })
    .eq("id", projectId)
    .eq("owner_id", me.userId);
}

export async function saveInstructions(projectId: string, instructions: string): Promise<boolean> {
  const me = await requireMe();
  if (!UUID.test(projectId)) return false;
  const { error } = await (await supabaseServer())
    .from("projects")
    .update({ instructions: instructions.trim().slice(0, MAX_PROJECT_INSTRUCTIONS), updated_at: new Date().toISOString() })
    .eq("id", projectId)
    .eq("owner_id", me.userId);
  return !error;
}

/** Deletes the project and its files. Its chats are kept and go back to the main list. */
export async function deleteProject(projectId: string) {
  const me = await requireMe();
  if (!UUID.test(projectId)) return;
  const db = await supabaseServer();
  const { data: files } = await db
    .from("project_files")
    .select("path")
    .eq("project_id", projectId)
    .eq("owner_id", me.userId)
    .returns<{ path: string }[]>();
  const paths = (files ?? []).map((f) => f.path).filter((p) => p.startsWith(`${me.userId}/`));
  if (paths.length) await db.storage.from(UPLOAD_BUCKET).remove(paths);
  await db.from("projects").delete().eq("id", projectId).eq("owner_id", me.userId);
}

/** Keeps a file the browser already uploaded to the person's own folder in the project. */
export async function addProjectFile(projectId: string, file: unknown): Promise<ProjectFile | { error: string }> {
  const me = await requireMe();
  if (!UUID.test(projectId) || !isFileRef(file, me.userId)) return { error: "That file can't be added. Try again." };
  const db = await supabaseServer();
  const { count } = await db
    .from("project_files")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("owner_id", me.userId);
  if ((count ?? 0) >= MAX_PROJECT_FILES) {
    await db.storage.from(UPLOAD_BUCKET).remove([file.path]);
    return { error: `A project can hold up to ${MAX_PROJECT_FILES} files.` };
  }
  const { data, error } = await db
    .from("project_files")
    .insert({ project_id: projectId, owner_id: me.userId, path: file.path, name: file.name, mime: file.mime, size: file.size })
    .select("id, path, name, mime, size")
    .single<ProjectFile>();
  if (error || !data) {
    await db.storage.from(UPLOAD_BUCKET).remove([file.path]);
    return { error: "Couldn't add that file. Try again." };
  }
  await db.from("projects").update({ updated_at: new Date().toISOString() }).eq("id", projectId).eq("owner_id", me.userId);
  return data;
}

export async function removeProjectFile(fileId: string) {
  const me = await requireMe();
  if (!UUID.test(fileId)) return;
  const db = await supabaseServer();
  const { data } = await db
    .from("project_files")
    .delete()
    .eq("id", fileId)
    .eq("owner_id", me.userId)
    .select("path")
    .maybeSingle<{ path: string }>();
  // The stored file goes too (project files are uploaded for the project, never shared with a message).
  if (data?.path.startsWith(`${me.userId}/`)) await db.storage.from(UPLOAD_BUCKET).remove([data.path]);
}

/** Puts one of your chats in one of your projects, or (with null) back in the main list. */
export async function moveChat(chatId: string, projectId: string | null) {
  const me = await requireMe();
  if (!UUID.test(chatId) || (projectId !== null && !UUID.test(projectId))) return;
  await (await supabaseServer()).from("chats").update({ project_id: projectId }).eq("id", chatId).eq("owner_id", me.userId);
  if (projectId) {
    await (await supabaseServer())
      .from("projects")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", projectId)
      .eq("owner_id", me.userId);
  }
}
