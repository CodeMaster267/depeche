import "server-only";
import type { Me } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { chooseDefault, modelsFor } from "@/lib/ai/models";
import { after } from "next/server";
import { refreshKeyModels, staleKeys, type KeyModels } from "@/lib/ai/key-models";
import { activePath, type ChatRow, type MessageRow } from "@/lib/chat/thread";
import type { ProjectDetail, ProjectRow } from "@/lib/chat/projects";
import type { AssistantDetail, AssistantRow } from "@/lib/chat/assistants";

export type Shell = {
  userId: string;
  name: string;
  isAdmin: boolean;
  chats: ChatRow[];
  /** Your projects (folders), most recently used first. */
  projects: ProjectRow[];
  /** Your saved assistants and the ones your family shared, yours first. */
  assistants: AssistantRow[];
  modelIds: string[];
  defaultModel: string | null;
  spent: number;
  cap: number;
};

/** Everything the chat screen needs around the conversation: your chats, models and spending. */
export async function loadShell(me: Me): Promise<Shell> {
  const db = await supabaseServer();
  const [{ data: chats }, { data: providers }, { data: spent }, { data: projects }, { data: assistants }] = await Promise.all([
    // Admins can read their members' chat titles, so ask only for your own.
    db
      .from("chats")
      .select("id, title, model, pinned, updated_at, project_id, assistant_id")
      .eq("owner_id", me.userId)
      .is("archived_at", null)
      .order("updated_at", { ascending: false })
      .limit(500)
      .returns<ChatRow[]>(),
    db.rpc("family_models"),
    supabaseAdmin().rpc("month_spend", { p_person: me.userId }),
    db
      .from("projects")
      .select("id, name, updated_at")
      .eq("owner_id", me.userId)
      .order("updated_at", { ascending: false })
      .limit(200)
      .returns<ProjectRow[]>(),
    // Yours, and those shared with your family (row-level security decides which).
    db
      .from("assistants")
      .select("id, owner_id, name, description, model, shared")
      .order("name")
      .limit(200)
      .returns<(Omit<AssistantRow, "mine"> & { owner_id: string })[]>(),
  ]);
  const keys = (providers as KeyModels[] | null) ?? [];
  const models = modelsFor(keys);
  // Keep the list of usable models fresh, after the page has been sent.
  const stale = staleKeys(keys);
  if (stale.length) after(() => refreshKeyModels(me.profile.family_id, stale.map((k) => k.provider)));
  const { data: last } = await db.from("profiles").select("last_model").eq("id", me.userId).maybeSingle<{ last_model: string | null }>();
  return {
    userId: me.userId,
    name: me.profile.display_name,
    isAdmin: me.profile.role === "admin",
    chats: chats ?? [],
    projects: projects ?? [],
    assistants: (assistants ?? [])
      .map(({ owner_id, ...a }) => ({ ...a, mine: owner_id === me.userId }))
      .sort((a, b) => Number(b.mine) - Number(a.mine)),
    modelIds: models.map((m) => m.id),
    defaultModel: chooseDefault(models, last?.last_model)?.id ?? null,
    spent: Number(spent ?? 0),
    cap: Number(me.profile.monthly_cap_usd),
  };
}

/**
 * One of your chats, or null if it isn't yours: the conversation as shown (`messages`, the newest
 * branch) and every version of every message (`all`), so the screen can flip between versions.
 */
export async function loadChat(me: Me, chatId: string): Promise<{ chat: ChatRow; messages: MessageRow[]; all: MessageRow[] } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(chatId)) return null;
  const db = await supabaseServer();
  const { data: chat } = await db
    .from("chats")
    .select("id, title, model, pinned, updated_at, archived_at, project_id, assistant_id, imported_from, created_at")
    .eq("id", chatId)
    .eq("owner_id", me.userId)
    .maybeSingle<ChatRow>();
  if (!chat) return null;
  const { data: messages } = await db
    .from("messages")
    .select("id, chat_id, parent_id, role, content, status, model, created_at")
    .eq("chat_id", chatId)
    .order("created_at")
    .returns<MessageRow[]>();
  const all = messages ?? [];
  const path = activePath(all);
  // Memory suggestions still waiting for an answer, shown under the reply that made them.
  const replies = all.filter((m) => m.role === "assistant").map((m) => m.id);
  if (replies.length) {
    const { data: waiting } = await db
      .from("memories")
      .select("id, content, source_message_id")
      .eq("owner_id", me.userId)
      .eq("status", "suggested")
      .in("source_message_id", replies)
      .returns<{ id: string; content: string; source_message_id: string }[]>();
    for (const w of waiting ?? []) {
      const m = all.find((x) => x.id === w.source_message_id);
      if (m) m.memory = { id: w.id, content: w.content };
    }
  }
  return { chat, messages: path, all };
}

/** One of your projects with its instructions and files, or null if it isn't yours. */
export async function loadProject(me: Me, projectId: string): Promise<ProjectDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) return null;
  const db = await supabaseServer();
  const [{ data: project }, { data: files }] = await Promise.all([
    db
      .from("projects")
      .select("id, name, instructions, updated_at")
      .eq("id", projectId)
      .eq("owner_id", me.userId)
      .maybeSingle<Omit<ProjectDetail, "files">>(),
    db
      .from("project_files")
      .select("id, path, name, mime, size")
      .eq("project_id", projectId)
      .eq("owner_id", me.userId)
      .order("created_at")
      .returns<ProjectDetail["files"]>(),
  ]);
  if (!project) return null;
  return { ...project, files: files ?? [] };
}

/** A saved assistant you can see (yours, or shared with your family), with its instructions and files. */
export async function loadAssistant(me: Me, assistantId: string): Promise<AssistantDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(assistantId)) return null;
  const db = await supabaseServer();
  const { data: a } = await db
    .from("assistants")
    .select("id, owner_id, name, description, instructions, model, shared")
    .eq("id", assistantId)
    .maybeSingle<Omit<AssistantDetail, "mine" | "files"> & { owner_id: string }>();
  if (!a) return null;
  const { data: files } = await db
    .from("assistant_files")
    .select("id, path, name, mime, size")
    .eq("assistant_id", assistantId)
    .order("created_at")
    .returns<AssistantDetail["files"]>();
  const { owner_id, ...rest } = a;
  return { ...rest, mine: owner_id === me.userId, files: files ?? [] };
}
