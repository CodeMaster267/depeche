"use server";

import { revalidatePath } from "next/cache";
import { requireMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { MAX_MEMORY_CHARS } from "@/lib/chat/memory";
import { CHECK_MEMORY_LIMIT, cleanAbout, cleanFact, type Existing } from "@/lib/chat/memory-check";
import { checkMemory } from "@/lib/chat/memory-check-run";
import { MAX_INSTRUCTION_CHARS, cleanInstruction } from "@/lib/chat/instructions";

/**
 * Memories are yours alone: every change runs with your own session, so row-level security keeps
 * them away from everyone else, family admins and the app owner included.
 */
export async function decideMemory(id: string, keep: boolean): Promise<void> {
  const me = await requireMe();
  await (await supabaseServer())
    .from("memories")
    .update({ status: keep ? "active" : "rejected", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("owner_id", me.userId)
    .eq("status", "suggested");
  // No revalidation: the memory page is always read fresh, and refreshing would redraw the chat.
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What happened when a fact was offered to memory. */
export type MemoryOutcome =
  | { kind: "saved"; id: string; content: string; about: string | null }
  /** Already remembered: nothing was added. */
  | { kind: "duplicate"; content: string }
  /** Merged into older memories about the same person, which are archived (and can come back). */
  | { kind: "updated"; id: string; content: string; replaced: string[] }
  /** Doesn't fit what's remembered: the person decides. Nothing has been saved yet. */
  | { kind: "conflict"; fact: string; about: string | null; question: string; clashes: { id: string; content: string }[] }
  | { kind: "error"; error: string };

type Me = Awaited<ReturnType<typeof requireMe>>;
type Db = Awaited<ReturnType<typeof supabaseServer>>;

/** Saves a fact as active: the waiting suggestion becomes it, or a new row is added. */
async function keep(db: Db, me: Me, fact: string, about: string | null, suggestionId: string | null): Promise<string | null> {
  const now = new Date().toISOString();
  if (suggestionId) {
    const { data } = await db
      .from("memories")
      .update({ content: fact, about, status: "active", updated_at: now })
      .eq("id", suggestionId)
      .eq("owner_id", me.userId)
      .eq("status", "suggested")
      .select("id")
      .maybeSingle<{ id: string }>();
    if (data) return data.id;
  }
  const { data } = await db
    .from("memories")
    .insert({ owner_id: me.userId, content: fact, about, status: "active" })
    .select("id")
    .single<{ id: string }>();
  return data?.id ?? null;
}

/** Older memories a new one replaces: archived, pointing at it, so Undo can bring them back. */
async function retire(db: Db, me: Me, ids: string[], by: string): Promise<string[]> {
  if (!ids.length) return [];
  const { data } = await db
    .from("memories")
    .update({ status: "archived", replaced_by: by, updated_at: new Date().toISOString() })
    .in("id", ids)
    .eq("owner_id", me.userId)
    .eq("status", "active")
    .select("content")
    .returns<{ content: string }[]>();
  return (data ?? []).map((m) => m.content);
}

/**
 * Remembers a fact, after checking how it fits with everything already remembered: who it's
 * about, whether it's already there, whether it updates something, or whether it clashes (then
 * the person is asked and nothing is saved until they answer).
 *
 * `suggestionId` is a reply's suggestion being kept; its own text is used unless the person
 * rewrote it. Everything is read and written with the person's own session.
 */
export async function rememberFact(input: { content?: string; suggestionId?: string; from?: "chat" | "page" }): Promise<MemoryOutcome> {
  const me = await requireMe();
  const db = await supabaseServer();
  const suggestionId = input.suggestionId && UUID.test(input.suggestionId) ? input.suggestionId : null;
  let fact = cleanFact(input.content);
  if (suggestionId && !fact) {
    const { data } = await db
      .from("memories")
      .select("content")
      .eq("id", suggestionId)
      .eq("owner_id", me.userId)
      .eq("status", "suggested")
      .maybeSingle<{ content: string }>();
    fact = cleanFact(data?.content);
  }
  if (!fact) return { kind: "error", error: "Write something to remember." };
  if (String(input.content ?? "").replace(/\s+/g, " ").trim().length > MAX_MEMORY_CHARS) {
    return { kind: "error", error: `Keep it under ${MAX_MEMORY_CHARS} characters.` };
  }

  const { data: rows } = await db
    .from("memories")
    .select("id, content, about")
    .eq("owner_id", me.userId)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(CHECK_MEMORY_LIMIT)
    .returns<Existing[]>();
  const existing = rows ?? [];
  const { verdict } = await checkMemory({ userId: me.userId, familyId: me.profile.family_id, name: me.profile.display_name }, fact, existing);
  const refresh = () => {
    if (input.from !== "chat") revalidatePath("/memory");
  };

  if (verdict.kind === "duplicate") {
    const same = existing.find((m) => m.id === verdict.same);
    // A suggestion that's already remembered is simply cleared away; the old memory is kept.
    if (suggestionId) await db.from("memories").delete().eq("id", suggestionId).eq("owner_id", me.userId).eq("status", "suggested");
    if (same) await db.from("memories").update({ updated_at: new Date().toISOString() }).eq("id", same.id).eq("owner_id", me.userId);
    refresh();
    return { kind: "duplicate", content: same?.content ?? fact };
  }
  if (verdict.kind === "conflict") {
    return {
      kind: "conflict",
      fact: verdict.fact,
      about: verdict.about,
      question: verdict.question,
      clashes: existing.filter((m) => verdict.with.includes(m.id)).map((m) => ({ id: m.id, content: m.content })),
    };
  }
  const id = await keep(db, me, verdict.fact, verdict.about, suggestionId);
  if (!id) return { kind: "error", error: "Couldn't save that. Try again." };
  if (verdict.kind === "update") {
    const replaced = await retire(db, me, verdict.replaces, id);
    refresh();
    return replaced.length ? { kind: "updated", id, content: verdict.fact, replaced } : { kind: "saved", id, content: verdict.fact, about: verdict.about };
  }
  refresh();
  return { kind: "saved", id, content: verdict.fact, about: verdict.about };
}

/**
 * The person's answer to a clash: use the new fact instead of the old ones, keep the old ones and
 * drop the new, or keep both (they're about different things after all).
 */
export async function settleConflict(input: {
  choice: "new" | "old" | "both";
  fact: string;
  about: string | null;
  clashes: string[];
  suggestionId?: string;
  from?: "chat" | "page";
}): Promise<MemoryOutcome> {
  const me = await requireMe();
  const db = await supabaseServer();
  const suggestionId = input.suggestionId && UUID.test(input.suggestionId) ? input.suggestionId : null;
  const fact = cleanFact(input.fact);
  const about = cleanAbout(input.about);
  const clashes = (Array.isArray(input.clashes) ? input.clashes : []).filter((c) => typeof c === "string" && UUID.test(c)).slice(0, 20);
  if (!fact) return { kind: "error", error: "Write something to remember." };
  const refresh = () => {
    if (input.from !== "chat") revalidatePath("/memory");
  };
  if (input.choice === "old") {
    if (suggestionId) {
      await db.from("memories").update({ status: "rejected", updated_at: new Date().toISOString() }).eq("id", suggestionId).eq("owner_id", me.userId).eq("status", "suggested");
    }
    const { data } = clashes.length
      ? await db.from("memories").select("content").in("id", clashes).eq("owner_id", me.userId).returns<{ content: string }[]>()
      : { data: [] as { content: string }[] };
    refresh();
    return { kind: "duplicate", content: (data ?? []).map((m) => m.content).join(" ") || fact };
  }
  const id = await keep(db, me, fact, about, suggestionId);
  if (!id) return { kind: "error", error: "Couldn't save that. Try again." };
  if (input.choice === "new" && clashes.length) {
    const replaced = await retire(db, me, clashes, id);
    refresh();
    if (replaced.length) return { kind: "updated", id, content: fact, replaced };
  }
  refresh();
  return { kind: "saved", id, content: fact, about };
}

/** Undoes an update: the older memories come back and the new one goes. */
export async function undoReplace(id: string, from: "chat" | "page" = "page"): Promise<void> {
  if (!UUID.test(id)) return;
  const me = await requireMe();
  const db = await supabaseServer();
  await db
    .from("memories")
    .update({ status: "active", replaced_by: null, updated_at: new Date().toISOString() })
    .eq("replaced_by", id)
    .eq("owner_id", me.userId);
  await db.from("memories").delete().eq("id", id).eq("owner_id", me.userId);
  if (from !== "chat") revalidatePath("/memory");
}

export async function forgetMemory(id: string): Promise<void> {
  const me = await requireMe();
  await (await supabaseServer()).from("memories").delete().eq("id", id).eq("owner_id", me.userId);
  revalidatePath("/memory");
}

export async function forgetAll(): Promise<void> {
  const me = await requireMe();
  await (await supabaseServer()).from("memories").delete().eq("owner_id", me.userId);
  revalidatePath("/memory");
}

export type InstructionsState = { error?: string; ok?: string } | undefined;

/** Your personal instructions, saved as you, so nobody else (admins included) can read them. */
export async function saveInstructions(_: InstructionsState, form: FormData): Promise<InstructionsState> {
  const me = await requireMe();
  const about = cleanInstruction(String(form.get("about_me") ?? ""));
  const style = cleanInstruction(String(form.get("answer_style") ?? ""));
  if (about.length > MAX_INSTRUCTION_CHARS || style.length > MAX_INSTRUCTION_CHARS) {
    return { error: `Keep each one under ${MAX_INSTRUCTION_CHARS.toLocaleString("en-GB")} characters.` };
  }
  const db = await supabaseServer();
  const fields = { about_me: about, answer_style: style, enabled: form.get("enabled") === "on", updated_at: new Date().toISOString() };
  // Update first; only the very first save inserts. (An upsert would also try to update owner_id,
  // which nobody may change.)
  const updated = await db.from("personal_instructions").update(fields).eq("owner_id", me.userId).select("owner_id");
  let error = updated.error;
  if (!error && !updated.data?.length) {
    ({ error } = await db.from("personal_instructions").insert({ owner_id: me.userId, ...fields }));
  }
  if (error) return { error: "Couldn't save that. Try again." };
  revalidatePath("/memory");
  return { ok: "Saved. Depeche uses these in every chat from now on." };
}
