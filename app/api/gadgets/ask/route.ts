import { NextResponse, type NextRequest } from "next/server";
import { getMe } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { estimateCost, findModel, type Model } from "@/lib/ai/models";
import { ProviderError, streamReply } from "@/lib/ai/providers";
import { inputTokensUpperBound } from "@/lib/ai/budget";
import { allow } from "@/lib/rate-limit";
import { askModel, askableModels, familyKeys } from "@/lib/gadgets/server";

export const maxDuration = 120;

/** An answer to a gadget is short: a move, a question, a sentence or two. */
const ASK_OUTPUT = 1_200;
const MAX_PROMPT = 12_000;
const MAX_SYSTEM = 4_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

function askSystem(name: string, gadget: string, extra: string): string {
  return [
    `You are answering a request from a gadget: a small app inside Depeche, a private family chat app, used by ${name}. The gadget is "${gadget}".`,
    "Answer only what it asks, in exactly the format it asks for, as briefly as you can, with no preamble. Keep everything family friendly.",
    extra ? `The gadget's instructions:\n${extra}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The AIs a gadget may offer as a choice (depeche.models()). */
export async function GET() {
  const me = await getMe();
  if (!me) return fail(401, "Sign in again.");
  const { keys } = await familyKeys(me.profile.family_id);
  return NextResponse.json({ models: askableModels(keys).map((m) => ({ id: m.id, name: m.name })) });
}

/**
 * A gadget asks an AI: {prompt, system?, model?, gadget?, title?}. `gadget` is a saved gadget's id
 * (its chosen AI answers); a gadget still in a reply has none. Uses the family's keys, holds the
 * most it could cost against the person's spending limit first, and returns the answer with
 * what it actually cost, which the gadget's card shows.
 */
export async function POST(req: NextRequest) {
  const me = await getMe();
  if (!me) return fail(401, "Sign in again to use this gadget.");
  if (me.profile.must_change_password) return fail(403, "Choose a new password first, in Account.");
  if (!(await allow(["messagesPerMinute", me.userId], ["messagesPerDay", me.userId]))) {
    return fail(429, "This gadget is asking too often. Wait a minute and try again.");
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const prompt = typeof body.prompt === "string" ? body.prompt.slice(0, MAX_PROMPT) : "";
  if (!prompt.trim()) return fail(400, "The gadget didn't say what to ask.");
  const extra = typeof body.system === "string" ? body.system.slice(0, MAX_SYSTEM) : "";
  const wanted = typeof body.model === "string" ? body.model.slice(0, 80) : null;
  const gadgetId = typeof body.gadget === "string" && UUID.test(body.gadget) ? body.gadget : null;
  let title = typeof body.title === "string" ? body.title.slice(0, 60) : "Gadget";

  const admin = supabaseAdmin();
  let gadgetModel: string | null = null;
  if (gadgetId) {
    const { data: g } = await admin.from("gadgets").select("title, model").eq("id", gadgetId).eq("owner_id", me.userId).maybeSingle<{ title: string; model: string | null }>();
    if (!g) return fail(404, "That gadget isn't yours.");
    gadgetModel = g.model;
    title = g.title;
  }
  const [{ keys, keyOf }, { data: profile }] = await Promise.all([
    familyKeys(me.profile.family_id),
    admin.from("profiles").select("last_model").eq("id", me.userId).maybeSingle<{ last_model: string | null }>(),
  ]);
  const model: Model | undefined = askModel(askableModels(keys), wanted, gadgetModel, profile?.last_model ?? null);
  if (!model) return fail(400, me.profile.role === "admin" ? "Add an AI key in Family settings first." : "Your family admin hasn't added any AI keys yet.");
  const apiKey = keyOf(model.provider);
  if (!apiKey) return fail(500, "Your family's key needs to be added again. Ask your family admin.");

  const system = askSystem(me.profile.display_name.split(/\s+/)[0] ?? "someone", title, extra);
  const inputTokens = inputTokensUpperBound([system, prompt]);
  const worst = 1.5 * ((inputTokens * model.price.input + ASK_OUTPUT * model.price.output) / 1_000_000);
  const { data: holdRows, error: holdError } = await admin.rpc("reserve_spend", { p_person: me.userId, p_want: worst, p_need: worst });
  const hold = (holdRows as { hold_id: string }[] | null)?.[0];
  if (!hold) return fail(402, holdError?.code === "P0001" ? `${holdError.message}.` : "Couldn't check your spending limit. Try again.");

  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort());
  let text = "";
  let usage = { input: 0, output: 0 };
  let used = model;
  let error: string | null = null;
  try {
    for await (const ev of streamReply({ model, apiKey, system, turns: [{ role: "user", text: prompt }], signal: abort.signal, maxOutput: ASK_OUTPUT, think: false })) {
      if (ev.type === "text") text += ev.text;
      else if (ev.type === "usage") usage = { input: ev.input, output: ev.output };
      else if (ev.type === "model") used = findModel(ev.id) ?? used;
    }
  } catch (e) {
    error = e instanceof ProviderError ? e.message : "The AI didn't answer. Try again.";
  }
  const cost = estimateCost(used, usage.input, usage.output);
  await admin.rpc("settle_spend", {
    p_hold: hold.hold_id, p_message: null, p_provider: used.provider, p_model: used.id,
    p_input: usage.input, p_output: usage.output, p_cost: Number(cost.toFixed(6)),
  });
  if (error || !text.trim()) return NextResponse.json({ error: error ?? "The AI didn't answer. Try again.", cost, model: used.name }, { status: 502 });
  return NextResponse.json({ text: text.trim(), cost, model: used.name, modelId: used.id });
}
