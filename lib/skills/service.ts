import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { decryptSecret, fromBytea } from "@/lib/crypto";
import { allow } from "@/lib/rate-limit";
import type { Me } from "@/lib/auth/session";
import { CHECKERS, WRITERS, checkSkill, costOf, holdFor, pickModel, writeSkill, type Usage } from "./write";
import { screenRules } from "./screen";
import { textsOf, type Skill, type SkillDraft } from "./skill";
import type { Model } from "@/lib/ai/models";

/**
 * Making and changing skills, on the server only (the browser can't write skills). Every version
 * is checked before it's saved, whoever or whatever wrote it, and everything a model does here
 * counts toward the person's monthly spending limit.
 */

export type JobResult =
  | { ok: true; skill: SkillDraft & { id: string }; cost: number; model?: string }
  | { ok: false; status: number; error: string; refused?: boolean };

/** Skills one person can have made at once. */
export const MAX_OWNED = 100;

const fail = (status: number, error: string, refused = false): JobResult => ({ ok: false, status, error, refused });

export async function runSkillJob(
  me: Me,
  job: { kind: "create"; brief: string } | { kind: "ask"; skill: Skill; brief: string } | { kind: "edit"; skill: Skill; draft: SkillDraft },
  signal: AbortSignal,
): Promise<JobResult> {
  if (!(await allow(["skillWritesPerDay", me.userId], ["messagesPerMinute", me.userId]))) {
    return fail(429, "That's a lot of skills for one day. Try again tomorrow.");
  }
  const admin = supabaseAdmin();
  if (job.kind === "create") {
    const { count } = await admin.from("skills").select("id", { count: "exact", head: true }).eq("owner_id", me.userId);
    if ((count ?? 0) >= MAX_OWNED) return fail(400, `You've made ${MAX_OWNED} skills. Delete one before making another.`);
  }

  // What the person typed is checked first: free, and nothing is spent on a request that can't pass.
  const typed = job.kind === "edit" ? textsOf(job.draft) : [job.brief];
  const early = screenRules(typed);
  if (!early.ok) return fail(422, early.reason, true);

  const { data: keys } = await admin
    .from("provider_keys")
    .select("provider, models, ciphertext")
    .eq("family_id", me.profile.family_id)
    .returns<{ provider: string; models: string[] | null; ciphertext: string }[]>();
  const keyOf = (provider: string) => {
    const row = (keys ?? []).find((k) => k.provider === provider);
    if (!row) return null;
    try {
      return decryptSecret(fromBytea(row.ciphertext));
    } catch {
      return null;
    }
  };
  const writer = job.kind === "edit" ? null : pickModel(WRITERS, keys ?? []);
  const checker = pickModel(CHECKERS, keys ?? []);
  if ((job.kind !== "edit" && !writer) || !checker) {
    const need = "Skills are written by Claude Opus 5.5, Gemini 4 Argon or GPT-6.1 Sol";
    return fail(400, me.profile.role === "admin"
      ? `${need}. Add an Anthropic, Google or OpenAI key that can use one of them in Family settings first.`
      : `${need}. Ask your family admin to add an Anthropic, Google or OpenAI key that can use one of them.`);
  }
  const writerKey = writer ? keyOf(writer.provider) : null;
  const checkerKey = keyOf(checker.provider);
  if ((writer && !writerKey) || !checkerKey) return fail(500, "Your family's key needs to be added again. Ask your family admin.");

  // Hold the most this could cost against the monthly limit, like a reply.
  const current = job.kind === "create" ? undefined : draftOf(job.skill);
  const want = holdFor(writer ?? null, checker, [...typed, current ? JSON.stringify(current) : ""]);
  const { data: holdRows, error: holdError } = await admin.rpc("reserve_spend", { p_person: me.userId, p_want: want, p_need: want });
  const hold = (holdRows as { hold_id: string }[] | null)?.[0];
  if (!hold) return fail(402, holdError?.code === "P0001" ? `${holdError.message}.` : "Couldn't check your spending limit. Try again.");

  const spent: { model: Model; usage: Usage }[] = [];
  const settle = async () => {
    const cost = costOf(spent);
    const usage = spent.reduce((n, p) => ({ input: n.input + p.usage.input, output: n.output + p.usage.output }), { input: 0, output: 0 });
    const main = spent[0]?.model ?? checker;
    await admin.rpc("settle_spend", {
      p_hold: hold.hold_id, p_message: null, p_provider: main.provider, p_model: main.id,
      p_input: usage.input, p_output: usage.output, p_cost: Number(cost.toFixed(6)),
    });
    return cost;
  };

  try {
    let draft: SkillDraft;
    if (job.kind === "edit") draft = job.draft;
    else {
      const wrote = await writeSkill({ model: writer!, apiKey: writerKey!, brief: job.brief, current, personName: me.profile.display_name, signal });
      spent.push({ model: wrote.model, usage: wrote.usage });
      if (wrote.result.kind === "refused") {
        await settle();
        return fail(422, wrote.result.reason, true);
      }
      if (wrote.result.kind === "failed") {
        await settle();
        return fail(502, "The skill didn't come out right. Try again, perhaps describing it a little differently.");
      }
      draft = wrote.result.draft;
    }

    const checked = await checkSkill({ draft, model: checker, apiKey: checkerKey, openaiKey: keyOf("openai"), signal });
    spent.push({ model: checked.model, usage: checked.usage });
    if (!checked.result.ok) {
      await settle();
      return fail(422, checked.result.reason, true);
    }

    const saved = await save(me, job.kind === "create" ? null : job.skill, draft, writer?.id ?? null);
    const cost = await settle();
    if (!saved) return fail(500, "Couldn't save the skill. Try again.");
    return { ok: true, skill: { ...draft, ...saved }, cost, model: writer?.name };
  } catch {
    await settle();
    return fail(502, signal.aborted ? "Stopped." : "Something went wrong while writing the skill. Try again.");
  }
}

export function draftOf(s: Skill): SkillDraft {
  return { name: s.name, description: s.description, instructions: s.instructions, files: s.files ?? [], triggers: s.triggers ?? [] };
}

/** Saves a new skill (and adds it to its maker's list), or a new version of an existing one. */
async function save(me: Me, existing: Skill | null, draft: SkillDraft, model: string | null): Promise<{ id: string; name: string } | null> {
  const admin = supabaseAdmin();
  const fields = { description: draft.description, instructions: draft.instructions, files: draft.files, triggers: draft.triggers };
  // Names are unique across the library: a taken one gets a number on the end.
  for (let n = 1; n <= 20; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const name = `${draft.name.slice(0, 40 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (existing) {
      const { data, error } = await admin
        .from("skills")
        .update({ ...fields, name, version: existing.version + 1, updated_at: new Date().toISOString(), ...(model ? { model } : {}) })
        .eq("id", existing.id)
        .eq("owner_id", me.userId)
        .select("id, name")
        .maybeSingle<{ id: string; name: string }>();
      if (error?.code === "23505") continue;
      return data ?? null;
    }
    const { data, error } = await admin
      .from("skills")
      .insert({ ...fields, name, owner_id: me.userId, family_id: me.profile.family_id, model })
      .select("id, name")
      .maybeSingle<{ id: string; name: string }>();
    if (error?.code === "23505") continue;
    if (data) await admin.from("skill_picks").insert({ owner_id: me.userId, skill_id: data.id });
    return data ?? null;
  }
  return null;
}

