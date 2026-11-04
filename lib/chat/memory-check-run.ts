import "server-only";
import { estimateCost, findModel, type Model } from "@/lib/ai/models";
import { fakeAi, streamReply } from "@/lib/ai/providers";
import { inputTokensUpperBound } from "@/lib/ai/budget";
import { decryptSecret, fromBytea } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { CHECKERS, CHECK_MAX_OUTPUT, checkerPrompt, fakeCheck, plainCheck, readJson, readVerdict, type Existing, type Verdict } from "./memory-check";

/** A check never holds up saving for long: after this, the plain check is used instead. */
const CHECK_TIMEOUT_MS = 15_000;

type KeyRow = { provider: string; models: string[] | null; ciphertext: string };

export function pickChecker(keys: readonly { provider: string; models: readonly string[] | null }[]): Model | undefined {
  for (const id of CHECKERS) {
    const m = findModel(id);
    if (!m) continue;
    const key = keys.find((k) => k.provider === m.provider);
    if (key && (!key.models?.length || key.models.includes(id))) return m;
  }
  return undefined;
}

/**
 * Compares a new fact with the person's memories using the cheapest model their family has a key
 * for. Its small cost counts toward the person's monthly limit like any reply. When no model can
 * run (no key, over the limit, the provider is down), only an exact repeat is caught: a memory is
 * never lost because the check couldn't happen.
 *
 * The memories passed in were read with the person's own session; the service role is used only
 * for the family key and the spending records, which the browser may never touch.
 */
export async function checkMemory(person: { userId: string; familyId: string; name: string }, fact: string, existing: Existing[]): Promise<{ verdict: Verdict; checked: boolean }> {
  if (fakeAi()) return { verdict: fakeCheck(person.name, fact, existing), checked: true };
  const admin = supabaseAdmin();
  const { data: keys } = await admin
    .from("provider_keys")
    .select("provider, models, ciphertext")
    .eq("family_id", person.familyId)
    .returns<KeyRow[]>();
  const model = pickChecker(keys ?? []);
  const row = model && (keys ?? []).find((k) => k.provider === model.provider);
  if (!model || !row) return { verdict: plainCheck(fact, existing), checked: false };
  let apiKey: string;
  try {
    apiKey = decryptSecret(fromBytea(row.ciphertext));
  } catch {
    return { verdict: plainCheck(fact, existing), checked: false };
  }

  const { system, user } = checkerPrompt(person.name, fact, existing);
  const want = (inputTokensUpperBound([system, user]) * model.price.input + CHECK_MAX_OUTPUT * model.price.output) / 1_000_000;
  const { data: holdRows } = await admin.rpc("reserve_spend", { p_person: person.userId, p_want: want, p_need: want });
  const hold = (holdRows as { hold_id: string }[] | null)?.[0];
  if (!hold) return { verdict: plainCheck(fact, existing), checked: false };

  let text = "";
  let usage = { input: 0, output: 0 };
  let used = model;
  try {
    for await (const ev of streamReply({
      model, apiKey, system, turns: [{ role: "user", text: user }],
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), maxOutput: CHECK_MAX_OUTPUT, think: false,
    })) {
      if (ev.type === "text") text += ev.text;
      else if (ev.type === "usage") usage = { input: ev.input, output: ev.output };
      else if (ev.type === "model") used = findModel(ev.id) ?? used;
    }
  } catch {
    // Timed out or the provider failed; whatever arrived is still read below.
  }
  if (!usage.input && text) usage = { input: Math.ceil((system.length + user.length) / 3), output: Math.ceil(text.length / 3) };
  const cost = estimateCost(used, usage.input, usage.output);
  await admin.rpc("settle_spend", {
    p_hold: hold.hold_id, p_message: null, p_provider: used.provider, p_model: used.id,
    p_input: usage.input, p_output: usage.output, p_cost: Number(cost.toFixed(6)),
  });

  const verdict = readVerdict(readJson(text), fact, existing);
  return verdict ? { verdict, checked: true } : { verdict: plainCheck(fact, existing), checked: false };
}
