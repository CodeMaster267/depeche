import { NextResponse, type NextRequest } from "next/server";
import { getMe } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { decryptSecret, fromBytea } from "@/lib/crypto";
import { estimateCost, modelsFor, type Model, type Provider } from "@/lib/ai/models";
import { ProviderError, fakeAi, modelsThatMayAnswer, streamReply, type Turn } from "@/lib/ai/providers";
import { inputTokensUpperBound } from "@/lib/ai/budget";
import { allow } from "@/lib/rate-limit";
import { CONCIERGE_OUTPUT, MAX_QUESTION_CHARS, MAX_TURNS, conciergeModels, conciergeSystem, type HelpContext } from "@/lib/help/concierge";

export const maxDuration = 60;

const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

/**
 * Concierge, the help assistant: {turns: [{role, text}], page?}. Answers how-to questions about
 * Depeche from the guide in lib/help/guide.ts, fitted to the person's role and their family's keys.
 * Streams newline-separated JSON: {type:"model", name}, {type:"text", text}, then {type:"done",
 * cost} or {type:"error", error}.
 *
 * Nothing is saved except the cost, which counts toward the person's monthly limit like a chat.
 * It never sees their chats or memories.
 */
export async function POST(req: NextRequest) {
  const me = await getMe();
  if (!me) return fail(401, "Sign in again to ask Concierge.");
  if (me.profile.must_change_password) return fail(403, "Choose a new password first, in Account.");
  if (!(await allow(["messagesPerMinute", me.userId], ["messagesPerDay", me.userId]))) {
    return fail(429, "That's a lot of questions at once. Wait a minute and try again.");
  }
  const body = (await req.json().catch(() => ({}))) as { turns?: unknown; page?: unknown };
  const turns = cleanTurns(body.turns);
  if (!turns.length || turns.at(-1)!.role !== "user") return fail(400, "Ask a question first.");
  const page = typeof body.page === "string" && /^\/[\w\-/#?=&.[\]]{0,200}$/.test(body.page) ? body.page : undefined;

  const admin = supabaseAdmin();
  const [{ data: keys }, { data: spent }] = await Promise.all([
    admin
      .from("provider_keys")
      .select("provider, models, ciphertext")
      .eq("family_id", me.profile.family_id)
      .returns<{ provider: Provider; models: string[] | null; ciphertext: string }[]>(),
    admin.rpc("month_spend", { p_person: me.userId }),
  ]);
  const rows = keys ?? [];
  const candidates = conciergeModels(rows);
  if (!candidates.length) {
    return fail(
      400,
      me.profile.role === "admin"
        ? "Concierge needs an AI key. Add one in Family → AI providers (a Claude key is best)."
        : "Concierge needs an AI key. Ask your family admin to add one.",
    );
  }

  const context: HelpContext = {
    name: me.profile.display_name,
    role: me.profile.role,
    isOwner: me.profile.is_app_owner,
    providers: rows.map((k) => k.provider),
    models: modelsFor(rows).map((m) => m.name),
    spent: Number(spent ?? 0),
    cap: Number(me.profile.monthly_cap_usd),
    page,
  };
  const system = conciergeSystem(context);

  // Reserve the most this answer could cost: every model that might answer, writing the whole
  // guide to its cache, twice over in case the first one fails partway.
  const input = inputTokensUpperBound([system, ...turns.map((t) => t.text)]);
  const mayAnswer = candidates.flatMap(modelsThatMayAnswer);
  const want = 2 * Math.max(...mayAnswer.map((m) => estimateCost(m, input, CONCIERGE_OUTPUT, { write: input })));
  const { data: holdRows, error: holdError } = await admin.rpc("reserve_spend", { p_person: me.userId, p_want: want, p_need: want });
  const hold = (holdRows as { hold_id: string }[] | null)?.[0];
  if (!hold) return fail(402, holdError?.code === "P0001" ? `${holdError.message}.` : "Couldn't check your spending limit. Try again.");

  const keyOf = (provider: Provider) => {
    const row = rows.find((k) => k.provider === provider);
    try {
      return row ? decryptSecret(fromBytea(row.ciphertext)) : null;
    } catch {
      return null;
    }
  };

  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort());
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: object) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          // The person closed Concierge.
        }
      };
      let cost = 0;
      let used: Model = candidates[0];
      let tokens = { input: 0, output: 0 };
      let answered = false;
      let error = "Concierge couldn't answer. Try again.";
      try {
        if (fakeAi()) {
          // Tests: a fixed answer that shows the person's own details reached Concierge.
          send({ type: "model", name: used.name });
          const text = fakeAnswer(context, turns.at(-1)!.text);
          for (let i = 0; i < text.length; i += 24) {
            send({ type: "text", text: text.slice(i, i + 24) });
            await new Promise((r) => setTimeout(r, 8));
          }
          answered = true;
        }
        for (const model of answered ? [] : candidates) {
          const apiKey = keyOf(model.provider);
          if (!apiKey) continue;
          used = model;
          let wrote = false;
          send({ type: "model", name: model.name });
          try {
            for await (const ev of streamReply({
              model, apiKey, system, turns, signal: abort.signal, maxOutput: CONCIERGE_OUTPUT, think: false,
              cacheKey: `concierge-${me.userId}`,
            })) {
              if (ev.type === "text") {
                wrote = true;
                send({ type: "text", text: ev.text });
              } else if (ev.type === "usage") {
                cost += estimateCost(used, ev.input, ev.output, { read: ev.cacheRead, write: ev.cacheWrite });
                tokens = { input: tokens.input + ev.input, output: tokens.output + ev.output };
              } else if (ev.type === "model") {
                used = mayAnswer.find((m) => m.id === ev.id) ?? used;
              }
            }
            answered = true;
            break;
          } catch (e) {
            if (abort.signal.aborted) break;
            if (e instanceof ProviderError) error = e.message;
            console.error("[concierge] model failed", model.id, e instanceof Error ? e.message : e);
            // Half an answer can't be continued by another model.
            if (wrote) break;
          }
        }
      } finally {
        await admin.rpc("settle_spend", {
          p_hold: hold.hold_id, p_message: null, p_provider: used.provider, p_model: used.id,
          p_input: tokens.input, p_output: tokens.output, p_cost: Number(cost.toFixed(6)),
        });
      }
      send(answered ? { type: "done", cost } : { type: "error", error });
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}

/** The conversation as sent by the browser, checked and trimmed to the newest turns. */
function cleanTurns(raw: unknown): Turn[] {
  if (!Array.isArray(raw)) return [];
  const turns: Turn[] = [];
  for (const t of raw.slice(-MAX_TURNS)) {
    const role = (t as { role?: unknown })?.role;
    const text = (t as { text?: unknown })?.text;
    if ((role !== "user" && role !== "assistant") || typeof text !== "string" || !text.trim()) continue;
    const clean = text.trim().slice(0, role === "user" ? MAX_QUESTION_CHARS : 6_000);
    // Providers expect turns to alternate.
    if (turns.at(-1)?.role === role) turns[turns.length - 1] = { role, text: `${turns.at(-1)!.text}\n\n${clean}` };
    else turns.push({ role, text: clean });
  }
  while (turns[0]?.role === "assistant") turns.shift();
  return turns;
}

function fakeAnswer(c: HelpContext, question: string): string {
  const where =
    c.role === "admin"
      ? "1. Open [Family → AI providers](/family#ai-providers).\n2. Paste the key into its row and tap \"Save key\"."
      : "Only your family admin can add keys, so ask them to add it in Family → AI providers.";
  return `You asked: "${question.slice(0, 80)}". ${c.role === "admin" ? "As a family admin" : "As a member"}, here's how:\n\n${where}\n\nYour family has keys for: ${c.providers.join(", ") || "nothing yet"}.`;
}
