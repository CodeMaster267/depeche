import { NextResponse, type NextRequest } from "next/server";
import { getMe } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { decryptSecret, fromBytea } from "@/lib/crypto";
import { estimateCost } from "@/lib/ai/models";
import { ProviderError } from "@/lib/ai/providers";
import { inputTokensUpperBound } from "@/lib/ai/budget";
import { allow } from "@/lib/rate-limit";
import { BUILD_OUTPUT, buildDesign, flaggedByModeration, pickBuilder } from "@/lib/design/build";
import { builderSystem } from "@/lib/design/prompt";
import { NOT_FRIENDLY, familyFriendly } from "@/lib/design/friendly";
import { buildMeter, designsOffEverywhere, familyDesignsEnabled } from "@/lib/design/load";
import { DEFAULT_SPEC, cleanSpec, type Spec } from "@/lib/design/spec";

// The strongest models can take a minute or two to design. Vercel Hobby allows up to 300 seconds.
export const maxDuration = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status: number, error: string, extra: object = {}) => NextResponse.json({ error, ...extra }, { status });

/** The build meter: how many builds this person has used this month, and may use. */
export async function GET() {
  const me = await getMe();
  if (!me) return fail(401, "Sign in again.");
  const [meter, enabled] = await Promise.all([buildMeter(me.userId), familyDesignsEnabled(me.profile.family_id)]);
  return NextResponse.json({ ...meter, enabled });
}

/**
 * Builds a design from a brief: {brief, for?}. `for` is a family member's id when their admin
 * designs on their behalf. The design is saved waiting for Keep or Undo (or, for someone else,
 * offered to them), and returned so the screen can show it straight away.
 *
 * Checked in this order: signed in, designs on, family friendly, builds left (counted only if the
 * build succeeds), spending limit. Everything is written by the server.
 */
export async function POST(req: NextRequest) {
  const me = await getMe();
  if (!me) return fail(401, "Sign in again to change your look.");
  if (me.profile.must_change_password) return fail(403, "Choose a new password first, in Account.");
  if (!(await allow(["messagesPerMinute", me.userId], ["messagesPerDay", me.userId]))) {
    return fail(429, "That's a lot of requests at once. Wait a minute and try again.");
  }
  const body = (await req.json().catch(() => ({}))) as { brief?: unknown; for?: unknown };
  const brief = typeof body.brief === "string" ? body.brief.trim().slice(0, 2000) : "";
  if (brief.length < 3) return fail(400, "Describe the look you'd like first.");

  const admin = supabaseAdmin();
  const forId = typeof body.for === "string" && UUID.test(body.for) && body.for !== me.userId ? body.for : null;
  let owner = { id: me.userId, name: me.profile.display_name };
  if (forId) {
    const { data: allowed } = await admin.rpc("is_admin_of", { actor: me.userId, person: forId });
    if (!allowed) return fail(403, "Only their family admin can design for someone else.");
    const { data: them } = await admin.from("profiles").select("id, display_name").eq("id", forId).maybeSingle<{ id: string; display_name: string }>();
    if (!them) return fail(404, "That person isn't in your family.");
    owner = { id: them.id, name: them.display_name };
  }

  if (designsOffEverywhere() || !(await familyDesignsEnabled(me.profile.family_id))) {
    return fail(403, "Your family admin has turned off redesigns for now.");
  }

  // Family friendly, first by words (free and instant). A refusal is logged but never counted.
  const refuse = async (reason: string) => {
    await admin.from("design_builds").insert({
      family_id: me.profile.family_id, owner_id: owner.id, requested_by: me.userId, brief,
      status: "refused", note: reason, finished_at: new Date().toISOString(),
    });
    return fail(422, reason, { refused: true, ...(await buildMeter(me.userId)) });
  };
  if (!familyFriendly(brief)) return refuse(NOT_FRIENDLY);

  // The family's keys, and the strongest model among them.
  const { data: keys } = await admin
    .from("provider_keys")
    .select("provider, models, ciphertext")
    .eq("family_id", me.profile.family_id)
    .returns<{ provider: string; models: string[] | null; ciphertext: string }[]>();
  const model = pickBuilder(keys ?? []);
  if (!model) return fail(400, me.profile.role === "admin" ? "Add an AI key in Family settings first." : "Your family admin hasn't added any AI keys yet.");
  const keyOf = (provider: string) => {
    const row = (keys ?? []).find((k) => k.provider === provider);
    if (!row) return null;
    try {
      return decryptSecret(fromBytea(row.ciphertext));
    } catch {
      return null;
    }
  };
  const apiKey = keyOf(model.provider);
  if (!apiKey) return fail(500, "Your family's key needs to be added again. Ask your family admin.");

  // OpenAI's free moderation check, when the family has an OpenAI key.
  const openai = keyOf("openai");
  if (openai && (await flaggedByModeration(openai, brief))) return refuse(NOT_FRIENDLY);

  // The person's current design, which the new one builds on.
  const { data: cur } = await admin.from("design_current").select("design_id").eq("owner_id", owner.id).maybeSingle<{ design_id: string | null }>();
  let current: Spec = DEFAULT_SPEC;
  if (cur?.design_id) {
    const { data } = await admin.from("designs").select("spec").eq("id", cur.design_id).maybeSingle<{ spec: unknown }>();
    if (data) current = cleanSpec(data.spec);
  }

  // Take one build from the allowance (given back below if the build fails).
  const { data: buildId, error: startError } = await admin.rpc("start_design_build", { p_requester: me.userId, p_owner: owner.id, p_brief: brief });
  if (startError || !buildId) {
    return fail(402, startError?.code === "P0001" ? `${startError.message}.` : "Couldn't start the build. Try again.", await buildMeter(me.userId));
  }
  const finish = (patch: Record<string, unknown>) =>
    admin.from("design_builds").update({ ...patch, finished_at: new Date().toISOString() }).eq("id", buildId as string);

  // Builds cost money, so they count toward the person's monthly spending limit like a reply.
  // Up to two answers (one retry), each up to BUILD_OUTPUT tokens.
  const inputTokens = inputTokensUpperBound([builderSystem(current, owner.name, !!forId), brief]);
  const want = 2 * ((inputTokens * model.price.input + BUILD_OUTPUT * model.price.output) / 1_000_000);
  const { data: holdRows, error: holdError } = await admin.rpc("reserve_spend", { p_person: me.userId, p_want: want, p_need: want });
  const hold = (holdRows as { hold_id: string }[] | null)?.[0];
  if (!hold) {
    await finish({ status: "failed", note: "Over the spending limit" });
    return fail(402, holdError?.code === "P0001" ? `${holdError.message}.` : "Couldn't check your spending limit. Try again.", await buildMeter(me.userId));
  }

  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort());
  let outcome: Awaited<ReturnType<typeof buildDesign>> | null = null;
  let error = "Something went wrong while designing. Try again; failed builds don't count.";
  try {
    outcome = await buildDesign({ model, apiKey, current, brief, personName: owner.name, forSomeoneElse: !!forId, signal: abort.signal });
  } catch (e) {
    if (e instanceof ProviderError) error = `${e.message} Failed builds don't count.`;
  }
  const usage = outcome?.usage ?? { input: 0, output: 0 };
  const used = outcome?.model ?? model;
  const cost = estimateCost(used, usage.input, usage.output);
  await admin.rpc("settle_spend", {
    p_hold: hold.hold_id, p_message: null, p_provider: used.provider, p_model: used.id,
    p_input: usage.input, p_output: usage.output, p_cost: Number(cost.toFixed(6)),
  });

  const result = outcome?.result;
  if (!result || result.kind === "failed") {
    await finish({ status: "failed", model: used.id, cost_usd: cost, note: result?.reason ?? error.slice(0, 500) });
    return fail(502, result ? "The designer's answer didn't work out. Try again, perhaps with a simpler description; failed builds don't count." : error, await buildMeter(me.userId));
  }
  if (result.kind === "refused") {
    await finish({ status: "refused", model: used.id, cost_usd: cost, note: result.reason });
    return fail(422, result.reason, { refused: true, ...(await buildMeter(me.userId)) });
  }

  const { data: design, error: saveError } = await admin
    .from("designs")
    .insert({
      owner_id: owner.id, build_id: buildId, made_by: me.userId, name: result.spec.name.slice(0, 60) || "My look",
      spec: result.spec, status: forId ? "offered" : "preview",
    })
    .select("id")
    .single<{ id: string }>();
  if (saveError || !design) {
    await finish({ status: "failed", model: used.id, cost_usd: cost, note: "Couldn't be saved" });
    return fail(500, "Couldn't save the design. Try again; failed builds don't count.", await buildMeter(me.userId));
  }
  await finish({ status: "built", model: used.id, cost_usd: cost, unmet: result.unmet });
  // Keep the history to the newest 30 designs a person hasn't kept.
  const { data: old } = await admin
    .from("designs")
    .select("id")
    .eq("owner_id", owner.id)
    .eq("status", "undone")
    .order("created_at", { ascending: false })
    .range(30, 200);
  if (old?.length) await admin.from("designs").delete().in("id", old.map((d) => d.id));

  return NextResponse.json({
    design: { id: design.id, spec: result.spec },
    offered: !!forId,
    unmet: result.unmet,
    adjusted: result.fixes.length > 0,
    model: used.name,
    ...(await buildMeter(me.userId)),
  });
}
