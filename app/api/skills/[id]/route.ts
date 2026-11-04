import { NextResponse, type NextRequest } from "next/server";
import { getMe } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { runSkillJob } from "@/lib/skills/service";
import { MAX_BRIEF, cleanDraft, type Skill } from "@/lib/skills/skill";

export const maxDuration = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status: number, error: string, extra: object = {}) => NextResponse.json({ error, ...extra }, { status });

/** The skill, if the signed-in person made it and it's still in the library. */
async function own(id: string, userId: string): Promise<Skill | Response> {
  if (!UUID.test(id)) return fail(404, "That skill doesn't exist.");
  const { data } = await supabaseAdmin().from("skills").select("*").eq("id", id).maybeSingle<Skill>();
  if (!data) return fail(404, "That skill doesn't exist.");
  if (data.owner_id !== userId) return fail(403, "Only the person who made a skill can change it.");
  if (data.status !== "published") return fail(403, "This skill was removed from the library, so it can't be changed. You can still delete it.");
  return data;
}

/** Changes a skill by asking the model: {ask}. The model may rename it if the change calls for it. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const me = await getMe();
  if (!me) return fail(401, "Sign in again.");
  const skill = await own((await params).id, me.userId);
  if (skill instanceof Response) return skill;
  const body = (await req.json().catch(() => ({}))) as { ask?: unknown };
  const ask = typeof body.ask === "string" ? body.ask.trim().slice(0, MAX_BRIEF) : "";
  if (ask.length < 4) return fail(400, "Say what you'd like changed.");
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort());
  const result = await runSkillJob(me, { kind: "ask", skill, brief: ask }, abort.signal);
  if (!result.ok) return fail(result.status, result.error, { refused: result.refused });
  return NextResponse.json({ skill: result.skill, cost: result.cost });
}

/**
 * Changes a skill directly: {description, instructions, files, triggers}. The name stays the one
 * the model chose. The new version is checked just like a new skill before it's saved.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const me = await getMe();
  if (!me) return fail(401, "Sign in again.");
  const skill = await own((await params).id, me.userId);
  if (skill instanceof Response) return skill;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const draft = cleanDraft({ ...body, name: skill.name });
  if (!draft) return fail(400, "A skill needs a description and instructions.");
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort());
  const result = await runSkillJob(me, { kind: "edit", skill, draft }, abort.signal);
  if (!result.ok) return fail(result.status, result.error, { refused: result.refused });
  return NextResponse.json({ skill: result.skill, cost: result.cost });
}
