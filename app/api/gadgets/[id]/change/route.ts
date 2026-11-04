import { NextResponse, type NextRequest } from "next/server";
import { getMe } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { estimateCost, findModel } from "@/lib/ai/models";
import { ProviderError, streamReply } from "@/lib/ai/providers";
import { inputTokensUpperBound } from "@/lib/ai/budget";
import { allow } from "@/lib/rate-limit";
import { pickBuilder } from "@/lib/design/build";
import { familyKeys } from "@/lib/gadgets/server";
import { GADGET_RULES } from "@/lib/widgets/instructions";
import { MAX_WIDGET } from "@/lib/widgets/frame";
import { saveVersion } from "@/lib/gadgets/store";

export const maxDuration = 300;

/** A whole page can come back, so the answer may be long. */
const CHANGE_OUTPUT = 20_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status: number, error: string, extra: object = {}) => NextResponse.json({ error, ...extra }, { status });

function fenceFor(text: string): string {
  let f = "```";
  while (text.includes(f)) f += "`";
  return f;
}

function changeSystem(name: string, title: string, html: string): string {
  const fence = fenceFor(html);
  return [
    `You are changing a gadget: a small app inside Depeche, a private family chat app, that ${name} saved. It is called "${title}".`,
    "Make the change they ask for and keep everything else working as it did. Reply with one sentence on what you changed, then the whole updated page in a fenced code block labelled widget: and the title, for example ```widget:Chess. Write the whole page; never leave parts out or write placeholders.",
    "If the change can't be done within these rules, or isn't family friendly, say so in one sentence and don't write a page.",
    GADGET_RULES,
    `The gadget's page now:\n${fence}widget:${title.replace(/\s+/g, "-")}\n${html}\n${fence}`,
  ].join("\n\n");
}

/** The page in the first ```widget block of a reply, if there is one. */
function pageFrom(reply: string): string | null {
  const m = /(^|\n)(`{3,})widget(?::[^\n]*)?\n([\s\S]*?)\n\2(?:\n|$)/.exec(reply);
  return m ? m[3] : null;
}

/** Changes a saved gadget by asking: {request}. Uses the family's strongest model; the cost is the person's. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const me = await getMe();
  if (!me) return fail(401, "Sign in again to change this gadget.");
  if (!UUID.test(id)) return fail(404, "That gadget isn't yours.");
  if (!(await allow(["messagesPerMinute", me.userId], ["messagesPerDay", me.userId]))) {
    return fail(429, "That's a lot of changes at once. Wait a minute and try again.");
  }
  const body = (await req.json().catch(() => ({}))) as { request?: unknown };
  const request = typeof body.request === "string" ? body.request.trim().slice(0, 2000) : "";
  if (request.length < 2) return fail(400, "Say what you'd like changed first.");

  const admin = supabaseAdmin();
  const { data: gadget } = await admin
    .from("gadgets")
    .select("id, title, html")
    .eq("id", id)
    .eq("owner_id", me.userId)
    .maybeSingle<{ id: string; title: string; html: string }>();
  if (!gadget) return fail(404, "That gadget isn't yours.");

  const { keys, keyOf } = await familyKeys(me.profile.family_id);
  const model = pickBuilder(keys);
  if (!model) return fail(400, me.profile.role === "admin" ? "Add an AI key in Family settings first." : "Your family admin hasn't added any AI keys yet.");
  const apiKey = keyOf(model.provider);
  if (!apiKey) return fail(500, "Your family's key needs to be added again. Ask your family admin.");

  const name = me.profile.display_name.split(/\s+/)[0] ?? "someone";
  const system = changeSystem(name, gadget.title, gadget.html);
  const inputTokens = inputTokensUpperBound([system, request]);
  const worst = 1.5 * ((inputTokens * model.price.input + CHANGE_OUTPUT * model.price.output) / 1_000_000);
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
    for await (const ev of streamReply({ model, apiKey, system, turns: [{ role: "user", text: request }], signal: abort.signal, maxOutput: CHANGE_OUTPUT, think: false })) {
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
  if (error) return fail(502, error, { cost });

  const page = pageFrom(text);
  const said = text.replace(/(`{3,})widget[\s\S]*?\n\1/, "").trim().slice(0, 300);
  if (!page) return fail(422, said || "The AI couldn't make that change. Try saying it another way.", { cost });
  if (page.length > MAX_WIDGET) return fail(422, "The changed gadget came out too big. Try a smaller change.", { cost });
  await saveVersion(me.userId, gadget.id, page, request.slice(0, 300));
  return NextResponse.json({ html: page, note: said, cost, model: used.name });
}
