import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { decryptSecret, fromBytea } from "@/lib/crypto";
import { MODELS, estimateCost, type Model } from "@/lib/ai/models";
import { inputTokensUpperBound, planReply } from "@/lib/ai/budget";
import { streamReply, type Turn } from "@/lib/ai/providers";
import { UPLOAD_BUCKET, isFileRef } from "@/lib/chat/files";
import type { MessageRow } from "@/lib/chat/thread";
import {
  REBUILD_AFTER,
  SUMMARISER_SYSTEM,
  SUMMARY_COLUMNS,
  SUMMARY_INPUT_TOKENS,
  SUMMARY_OUTPUT_TOKENS,
  activeSummary,
  approxTokens,
  missingDetails,
  missingDetailsRequest,
  parseSummary,
  planCompaction,
  summariserInput,
  transcriptLine,
  type SummaryRow,
} from "@/lib/chat/summary";

/** Tests can make chats compact sooner. Never on Vercel. */
export function compactOverride(): number | undefined {
  const n = Number(process.env.DEPECHE_COMPACT_AT);
  return !process.env.VERCEL && n > 0 ? n : undefined;
}

/**
 * Who writes summaries: the cheapest model of the chat's own provider that the family's key can
 * use, so the chat never goes to a provider the person didn't choose. Groq is for testing only and
 * its free tier can't read a long chat, so Groq chats are never summarised.
 */
export function summariserFor(chatModel: Model, keyModels: readonly string[] | null): Model | undefined {
  if (chatModel.provider === "groq") return undefined;
  return MODELS.filter((m) => m.provider === chatModel.provider && (!keyModels?.length || keyModels.includes(m.id)))
    .sort((a, b) => a.price.input + a.price.output * 0.1 - (b.price.input + b.price.output * 0.1))[0];
}

export type CompactResult = { summary: SummaryRow } | { skipped: string };

/**
 * Summarise `path` up to the point `planCompaction` picks (or `throughIndex`, to redo one), building
 * on the summary before it. The cost goes against the person's monthly limit like a reply's.
 */
export async function compactChat(opts: {
  userId: string;
  name: string;
  familyId: string;
  chatId: string;
  chatModel: Model;
  path: MessageRow[];
  summaries: SummaryRow[];
  signal: AbortSignal;
  /** Summarise up to this message even if not due (redo). */
  throughIndex?: number;
  override?: number;
}): Promise<CompactResult> {
  const { userId, chatId, chatModel, path, summaries, signal } = opts;
  const admin = supabaseAdmin();

  const base = activeSummary(path, summaries, opts.throughIndex);
  const through = opts.throughIndex ?? planCompaction(path, base?.index ?? -1, chatModel, opts.override)?.throughIndex;
  if (through === undefined || through <= (base?.index ?? -1)) return { skipped: "nothing to summarise" };

  const { data: key } = await admin
    .from("provider_keys")
    .select("ciphertext, models")
    .eq("family_id", opts.familyId)
    .eq("provider", chatModel.provider)
    .maybeSingle<{ ciphertext: string; models: string[] | null }>();
  const writer = key ? summariserFor(chatModel, key.models) : undefined;
  if (!key || !writer) return { skipped: "no model to write the summary" };
  let apiKey: string;
  try {
    apiKey = decryptSecret(fromBytea(key.ciphertext));
  } catch {
    return { skipped: "the family key can't be read" };
  }

  // Text files are read again so the summary can say what they contained (while they still exist).
  const storage = admin.storage.from(UPLOAD_BUCKET);
  const fileText = new Map<string, string>();
  const lines: string[] = [];
  const allLines = async (from: number) => {
    const out: string[] = [];
    for (const m of path.slice(from, through + 1)) {
      for (const f of m.role === "user" ? (m.content.files ?? []) : []) {
        if (f.mime !== "text/plain" || fileText.has(f.path) || !isFileRef(f, userId)) continue;
        const { data } = await storage.download(f.path);
        if (data) fileText.set(f.path, (await data.text()).slice(0, 20_000));
      }
      const line = transcriptLine(m, opts.name, fileText);
      if (line) out.push(line);
    }
    return out;
  };

  // Usually: the summary before plus the messages after it. After several summaries in a row, or to
  // redo one, rebuild from the original messages when they fit in one read, so errors don't pile up.
  const prior = base ? summaries.find((s) => s.id === base.summary.id) : undefined;
  let previous: { summary: string; facts: string[] } | null = prior ? { summary: prior.summary, facts: prior.facts } : null;
  let generation = prior ? prior.generation + 1 : 0;
  const fromStart = await allLines(0);
  const rebuild = !prior || prior.generation + 1 >= REBUILD_AFTER || opts.throughIndex !== undefined;
  if (rebuild && approxTokens(fromStart.join("\n\n")) <= SUMMARY_INPUT_TOKENS) {
    previous = null;
    generation = 0;
    lines.push(...fromStart);
  } else if (prior) {
    lines.push(...(await allLines(base!.index + 1)));
  } else lines.push(...fromStart);

  // Long stretches are read in parts, each building on the last.
  const parts: string[][] = [[]];
  let size = 0;
  for (const l of lines) {
    const t = approxTokens(l);
    if (size + t > SUMMARY_INPUT_TOKENS && parts.at(-1)!.length) {
      parts.push([]);
      size = 0;
    }
    parts.at(-1)!.push(l.slice(0, SUMMARY_INPUT_TOKENS * 4));
    size += t;
  }

  // Hold the most the whole job could cost against the person's limit.
  const inputs = parts.map((p) => p.join("\n\n"));
  // Each part may need a second call (the detail check), which reads the part again.
  const calls = parts.length * 2;
  const plan = planReply(
    [writer],
    2 * inputTokensUpperBound([...inputs, ...inputs.map(() => SUMMARISER_SYSTEM)]) + calls * SUMMARY_OUTPUT_TOKENS,
  );
  const { data: holds } = await admin.rpc("reserve_spend", { p_person: userId, p_want: plan.want, p_need: plan.need });
  const hold = (holds as { hold_id: string; amount_usd: number }[] | null)?.[0];
  if (!hold) return { skipped: "monthly limit" };
  const maxOutput = Math.min(SUMMARY_OUTPUT_TOKENS, Math.floor(plan.maxOutput(Number(hold.amount_usd)) / calls));

  let used = writer;
  let input = 0;
  let output = 0;
  let result: { summary: string; facts: string[] } | null = null;
  try {
    const ask = async (turns: Turn[]) => {
      let reply = "";
      for await (const ev of streamReply({ model: writer, apiKey, system: SUMMARISER_SYSTEM, turns, signal, maxOutput })) {
        if (ev.type === "text") reply += ev.text;
        else if (ev.type === "usage") {
          input += ev.input;
          output += ev.output;
        } else if (ev.type === "model") used = MODELS.find((m) => m.id === ev.id) ?? used;
      }
      return reply;
    };
    for (const part of inputs) {
      const question = summariserInput(previous, part);
      const reply = await ask([{ role: "user", text: question }]);
      let parsed = parseSummary(reply);
      if (!parsed.summary) throw new Error("empty summary");
      // Detail check: exact numbers, links and file names from the conversation that the summary
      // dropped are put back to the model once, which adds each one that could matter.
      const missing = missingDetails(part, parsed);
      if (missing.length) {
        const again = await ask([
          { role: "user", text: question },
          { role: "assistant", text: reply },
          { role: "user", text: missingDetailsRequest(missing) },
        ]).catch(() => "");
        const facts = parseSummary(again.includes("<facts>") ? again : "").facts;
        if (facts.length >= parsed.facts.length) parsed = { summary: parsed.summary, facts };
      }
      // An earlier fact whose exact details vanished without being replaced is carried forward.
      const kept = previous?.facts.filter((f) => !parsed.facts.includes(f) && missingDetails(f, parsed).length > 0) ?? [];
      previous = { summary: parsed.summary, facts: [...kept, ...parsed.facts].slice(0, 300) };
      result = previous;
    }
  } catch (e) {
    await settle(admin, hold.hold_id, used, input, output);
    return { skipped: e instanceof Error ? e.message : "the summary failed" };
  }
  const cost = await settle(admin, hold.hold_id, used, input, output);
  if (!result) return { skipped: "the summary failed" };

  const { data: saved, error } = await admin
    .from("chat_summaries")
    .insert({
      chat_id: chatId,
      owner_id: userId,
      through_message_id: path[through].id,
      previous_id: generation ? (prior?.id ?? null) : null,
      generation,
      summary: result.summary,
      facts: result.facts,
      provider: used.provider,
      model: used.id,
      input_tokens: input,
      output_tokens: output,
      cost_usd: Number(cost.toFixed(6)),
    })
    .select(SUMMARY_COLUMNS)
    .single<SummaryRow>();
  if (saved) return { summary: saved };
  if (error?.code === "23505") {
    // Another tab summarised the same point first: use theirs.
    const { data: theirs } = await admin
      .from("chat_summaries")
      .select(SUMMARY_COLUMNS)
      .eq("chat_id", chatId)
      .eq("through_message_id", path[through].id)
      .eq("status", "active")
      .maybeSingle<SummaryRow>();
    if (theirs) return { summary: theirs };
  }
  return { skipped: "couldn't save the summary" };
}

async function settle(admin: ReturnType<typeof supabaseAdmin>, hold: string, model: Model, input: number, output: number) {
  const cost = estimateCost(model, input, output);
  await admin.rpc("settle_spend", {
    p_hold: hold,
    p_message: null,
    p_provider: model.provider,
    p_model: model.id,
    p_input: input,
    p_output: output,
    p_cost: Number(cost.toFixed(6)),
  });
  return cost;
}

/** The active summaries of a chat, oldest first. Read as the person, so only their own. */
export async function loadSummaries(
  db: { from: (t: string) => unknown },
  chatId: string,
): Promise<SummaryRow[]> {
  const q = (db as ReturnType<typeof supabaseAdmin>)
    .from("chat_summaries")
    .select(SUMMARY_COLUMNS)
    .eq("chat_id", chatId)
    .eq("status", "active")
    .order("created_at");
  const { data } = await q.returns<SummaryRow[]>();
  return (data ?? []).map((s) => ({ ...s, cost_usd: Number(s.cost_usd) }));
}
