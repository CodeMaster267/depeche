import "server-only";
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { pushTo } from "@/lib/push/server";
import { serviceRoleKey } from "@/lib/config";
import { decryptSecret, fromBytea } from "@/lib/crypto";
import { MAX_SEARCHES, estimateCost, findModel, searchCost, type Model } from "@/lib/ai/models";
import { ProviderError, fakeAi, modelsThatMayAnswer, streamReply } from "@/lib/ai/providers";
import { inputTokensUpperBound, planReply } from "@/lib/ai/budget";
import type { MessageRow, Source } from "@/lib/chat/thread";
export { RUN_COLUMNS } from "./types";
import {
  MAX_CONTINUATIONS,
  NOTES_MAX_OUTPUT,
  REPORT_MAX_OUTPUT,
  continuePrompt,
  linksIn,
  mergeSources,
  notesPrompt,
  parsePlan,
  planPrompt,
  reportPrompt,
  type Note,
} from "./prompts";

/**
 * Runs deep research in steps. Vercel Hobby stops a function after 300 seconds, and a full run
 * (plan, three to five rounds of web search, a long report) can take longer, so each step does as
 * much as fits in about four and a half minutes, saves its progress in research_runs, and then asks
 * the server to carry on with a fresh request to /api/research/step. If that hand-over is ever lost,
 * the open chat nudges the run along when it notices it has stalled.
 *
 * Every model call reserves its worst-case cost against the person's monthly limit first and swaps
 * that hold for the real cost afterwards, exactly like a normal reply, so research can't overshoot.
 */

export type ResearchRun = {
  id: string;
  owner_id: string;
  chat_id: string;
  question_id: string;
  model: string;
  status: "running" | "done" | "failed" | "stopped";
  phase: "planning" | "researching" | "writing";
  context: string;
  instructions: string;
  title: string | null;
  questions: string[];
  notes: Note[];
  sources: Source[];
  draft: string;
  continuations: number;
  notices: string[];
  searches: number;
  cost_usd: number | string;
  error: string | null;
  report_id: string | null;
  created_at: string;
  updated_at: string;
};


/** How long one step may work, leaving time to save before Vercel's 300-second limit. */
const STEP_MS = 270_000;
/** Don't start researching another question with less time than this left in the step. */
const NOTES_NEEDS_MS = 100_000;
/** Don't start the report with less time than this left, unless the step has done nothing yet. */
const REPORT_NEEDS_MS = 160_000;
/** A step holds the run this long; a step that died lets go when it runs out. */
const LEASE_SECONDS = 330;
/** About how many input tokens the pages from one web search add, erring high (as in /api/chat). */
const SEARCH_INPUT_TOKENS = 12_000;

const chainKey = () => Buffer.from(hkdfSync("sha256", serviceRoleKey() ?? "", "depeche", "research chain v1", 32));

/** Proves a hand-over request came from this server: only it knows the key. */
export function chainToken(runId: string): string {
  return createHmac("sha256", chainKey()).update(runId).digest("hex");
}

export function validChainToken(runId: string, token: string | null): boolean {
  if (!token || !serviceRoleKey()) return false;
  const want = Buffer.from(chainToken(runId));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Asks the server to run the next step as a new request, so it gets its own time limit. */
export async function handOver(origin: string, runId: string): Promise<void> {
  try {
    await fetch(`${origin}/api/research/step`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-depeche-research": chainToken(runId) },
      body: JSON.stringify({ id: runId }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    // The open chat will notice the run has stalled and nudge it.
    console.error("[research] hand-over failed", e instanceof Error ? e.message : e);
  }
}

type Admin = ReturnType<typeof supabaseAdmin>;

/** Runs the next step of a research run, if it is still running and no other step has it. */
export async function advance(runId: string, origin: string): Promise<void> {
  const admin = supabaseAdmin();
  const started = Date.now();
  const deadline = started + STEP_MS;
  const now = new Date().toISOString();
  const { data: claimed } = await admin
    .from("research_runs")
    .update({ lease_until: new Date(started + LEASE_SECONDS * 1000).toISOString() })
    .eq("id", runId)
    .eq("status", "running")
    .or(`lease_until.is.null,lease_until.lt.${now}`)
    .select("*")
    .maybeSingle<ResearchRun>();
  if (!claimed) return;

  let run = claimed;
  const save = async (patch: Partial<ResearchRun>) => {
    run = { ...run, ...patch };
    await admin
      .from("research_runs")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", runId)
      .eq("status", "running");
  };

  let more = false;
  try {
    const model = findModel(run.model);
    const key = model ? await familyKey(admin, run.owner_id, model) : null;
    if (!model || !key) {
      await save({ status: "failed", error: `Your family's key for ${model?.name ?? "this model"} isn't available any more.` });
      return;
    }
    const { data: q } = await admin.from("messages").select("content").eq("id", run.question_id).maybeSingle<{ content: MessageRow["content"] }>();
    const request = (q?.content.text ?? "").trim();
    // Local tests only: "handover" makes every step hand over after one call, to test the chain.
    const handEach = fakeAi() && request.includes("handover");
    let calls = 0;

    for (;;) {
      if (await stopped(admin, runId)) return;
      const left = deadline - Date.now();

      if (run.phase === "planning") {
        const p = planPrompt(request, run.context);
        const r = await callModel(admin, run, model, key, { ...p, search: false, maxOutput: 1_500, deadline });
        calls++;
        if (r.capped) return void (await save({ status: "failed", error: r.capped }));
        const text = fakeAi() ? fakePlan(request) : r.text;
        const plan = parsePlan(text, request);
        await save({ phase: "researching", title: plan.title, questions: plan.questions, ...spent(run, r) });
        continue;
      }

      if (run.phase === "researching") {
        const i = run.notes.length;
        if (i >= run.questions.length) {
          await save({ phase: "writing" });
          continue;
        }
        if (calls && (left < NOTES_NEEDS_MS || handEach)) {
          more = true;
          break;
        }
        const p = notesPrompt(request, run.context, run.questions, i);
        const r = await callModel(admin, run, model, key, { ...p, search: true, maxOutput: NOTES_MAX_OUTPUT, deadline });
        calls++;
        if (r.capped) {
          // Out of budget: write up what was found, if anything was.
          if (run.notes.some((n) => !n.failed)) {
            await save({ phase: "writing", notices: addNotice(run.notices, "Your monthly limit was nearly reached, so the research stopped early."), ...spent(run, r) });
            continue;
          }
          return void (await save({ status: "failed", error: r.capped }));
        }
        if (r.stopped) return void (await save(spent(run, r)));
        const note: Note = r.error && !r.text.trim() ? { question: run.questions[i], text: "", failed: true } : { question: run.questions[i], text: r.text };
        const notes = [...run.notes, note];
        if (notes.length === run.questions.length && notes.every((n) => n.failed)) {
          return void (await save({ status: "failed", error: r.error ?? "The research couldn't be done. Try again.", notes, ...spent(run, r) }));
        }
        await save({
          notes,
          sources: mergeSources(run.sources, [...r.sources, ...linksIn(r.text)]),
          notices: r.notice ? addNotice(run.notices, r.notice) : run.notices,
          ...spent(run, r),
        });
        continue;
      }

      // Writing the report.
      if (calls && (left < REPORT_NEEDS_MS || handEach)) {
        more = true;
        break;
      }
      const p = reportPrompt(request, run.context, run.title ?? "", run.notes, run.sources, run.instructions);
      const user = run.draft ? `${p.user}\n\n${continuePrompt(run.draft)}` : p.user;
      const r = await callModel(admin, run, model, key, { system: p.system, user, search: false, maxOutput: REPORT_MAX_OUTPUT, deadline });
      calls++;
      if (r.capped) {
        if (run.draft) {
          await finish(admin, run, model, run.draft, addNotice(run.notices, "The report was cut short because your monthly limit was nearly reached."));
          return;
        }
        return void (await save({ status: "failed", error: r.capped }));
      }
      if (r.stopped) return void (await save(spent(run, r)));
      if (r.error && !r.text.trim()) return void (await save({ status: "failed", error: r.error, ...spent(run, r) }));
      const draft = run.draft + r.text;
      if (r.timedOut && run.continuations < MAX_CONTINUATIONS) {
        await save({ draft, continuations: run.continuations + 1, ...spent(run, r) });
        more = true;
        break;
      }
      run = { ...run, ...spent(run, r) };
      const notices = r.timedOut ? addNotice(run.notices, "The report was cut short by the time limit.") : run.notices;
      await finish(admin, run, model, draft, notices);
      return;
    }
  } catch (e) {
    console.error("[research] step failed", e);
    await save({ status: "failed", error: "Something went wrong while researching. Try again." });
  } finally {
    await admin.from("research_runs").update({ lease_until: null }).eq("id", runId);
    if (!more) await notifyEnd(admin, run);
  }
  if (more) await handOver(origin, runId);
}

/**
 * If this step ended the run, tell the person's devices (where they turned notifications on): research
 * takes minutes and they have usually left the app. Never quotes the report.
 */
async function notifyEnd(admin: Admin, run: ResearchRun) {
  const { data: end } = await admin.from("research_runs").select("status, title").eq("id", run.id).maybeSingle<{ status: string; title: string | null }>();
  if (end?.status !== "done" && end?.status !== "failed") return;
  await pushTo(run.owner_id, {
    title: end.title?.trim() || "Deep research",
    body: end.status === "done" ? "Your research report is ready." : "The research didn't finish. Open the chat to see why.",
    url: `/c/${run.chat_id}`,
    tag: `chat-${run.chat_id}`,
  }).catch(() => 0);
}

/** Saves the report as the reply to the question, and marks the run done. */
async function finish(admin: Admin, run: ResearchRun, model: Model, text: string, notices: string[]) {
  if (await stopped(admin, run.id)) return;
  const cost = Number(run.cost_usd);
  const { data: saved } = await admin
    .from("messages")
    .insert({
      chat_id: run.chat_id,
      owner_id: run.owner_id,
      parent_id: run.question_id,
      role: "assistant",
      content: {
        text: text.trim(),
        ...(run.sources.length ? { sources: run.sources } : {}),
        ...(notices.length ? { notice: notices.join(" ") } : {}),
        ...(run.searches ? { searches: run.searches } : {}),
        research: { title: run.title ?? "Research report", questions: run.questions, sources: run.sources.length },
        cost,
      },
      status: "completed",
      provider: model.provider,
      model: model.id,
    })
    .select("id")
    .single<{ id: string }>();
  await Promise.all([
    admin
      .from("research_runs")
      .update({ status: saved ? "done" : "failed", report_id: saved?.id ?? null, draft: "", error: saved ? null : "Couldn't save the report. Try again.", updated_at: new Date().toISOString() })
      .eq("id", run.id)
      .eq("status", "running"),
    admin.from("chats").update({ updated_at: new Date().toISOString() }).eq("id", run.chat_id),
  ]);
}

async function stopped(admin: Admin, runId: string): Promise<boolean> {
  const { data } = await admin.from("research_runs").select("status").eq("id", runId).maybeSingle<{ status: string }>();
  return data?.status !== "running";
}

async function familyKey(admin: Admin, ownerId: string, model: Model): Promise<string | null> {
  const { data: person } = await admin.from("profiles").select("family_id").eq("id", ownerId).maybeSingle<{ family_id: string }>();
  if (!person) return null;
  const { data: row } = await admin
    .from("provider_keys")
    .select("ciphertext")
    .eq("family_id", person.family_id)
    .eq("provider", model.provider)
    .maybeSingle<{ ciphertext: string }>();
  if (!row) return null;
  try {
    return decryptSecret(fromBytea(row.ciphertext));
  } catch {
    return null;
  }
}

const addNotice = (notices: string[], text: string) => (notices.includes(text) ? notices : [...notices, text]);

type CallResult = {
  text: string;
  sources: Source[];
  searches: number;
  cost: number;
  notice?: string;
  /** A provider error, worded for people. */
  error?: string;
  /** The person's monthly limit is (nearly) reached: the database's own words. */
  capped?: string;
  timedOut: boolean;
  stopped: boolean;
};

const spent = (run: ResearchRun, r: CallResult) => ({
  cost_usd: Number((Number(run.cost_usd) + r.cost).toFixed(6)),
  searches: run.searches + r.searches,
});

/**
 * One model call, paid for like a reply: reserve the most it could cost, run it (stopping at the
 * step's deadline or when the person stops the research), then record what it really cost.
 */
async function callModel(
  admin: Admin,
  run: ResearchRun,
  model: Model,
  apiKey: string,
  opts: { system: string; user: string; search: boolean; maxOutput: number; deadline: number },
): Promise<CallResult> {
  const result: CallResult = { text: "", sources: [], searches: 0, cost: 0, timedOut: false, stopped: false };
  const may = modelsThatMayAnswer(model);
  const searchInput = opts.search ? MAX_SEARCHES * SEARCH_INPUT_TOKENS : 0;
  const input = inputTokensUpperBound([opts.system, opts.user]);
  const plan = planReply(may, input, {
    extraUsd: opts.search ? Math.max(...may.map((m) => searchCost(m.provider, MAX_SEARCHES))) : 0,
    extraInputTokens: searchInput,
  });
  const { data, error: holdError } = await admin.rpc("reserve_spend", { p_person: run.owner_id, p_want: plan.want, p_need: plan.need });
  const hold = (data as { hold_id: string; amount_usd: number }[] | null)?.[0];
  if (!hold) {
    result.capped = holdError?.code === "P0001" ? `${holdError.message}.` : "Couldn't check your spending limit. Try again.";
    return result;
  }
  const maxOutput = Math.min(opts.maxOutput, plan.maxOutput(Number(hold.amount_usd)));

  const abort = new AbortController();
  const timer = setTimeout(() => {
    result.timedOut = true;
    abort.abort();
  }, Math.max(1_000, opts.deadline - Date.now()));
  // Notice a stop within a few seconds, even in the middle of a long call.
  const watch = setInterval(async () => {
    if (await stopped(admin, run.id).catch(() => false)) {
      result.stopped = true;
      abort.abort();
    }
  }, 5_000);

  let used = model;
  let usage: { input: number; output: number } | undefined;
  let queried = 0;
  try {
    for await (const ev of streamReply({ model, apiKey, system: opts.system, turns: [{ role: "user", text: opts.user }], signal: abort.signal, search: opts.search, maxOutput })) {
      if (ev.type === "text") result.text += ev.text;
      else if (ev.type === "usage") usage = { input: ev.input, output: ev.output };
      else if (ev.type === "model") used = findModel(ev.id) ?? model;
      else if (ev.type === "searching") {
        if (ev.query && ev.where !== "chat") queried++;
      } else if (ev.type === "sources") result.sources = ev.sources;
      else if (ev.type === "searches") result.searches = ev.count;
      else if (ev.type === "notice") result.notice = ev.text;
    }
  } catch (e) {
    if (!abort.signal.aborted) result.error = e instanceof ProviderError ? e.message : "Something went wrong while researching. Try again.";
  } finally {
    clearTimeout(timer);
    clearInterval(watch);
  }
  // A call cut short has no usage report: estimate about four characters per token, erring high.
  if (!usage) usage = { input: result.error ? 0 : input, output: Math.ceil(result.text.length / 4) };
  result.searches = Math.max(result.searches, queried);
  result.cost = estimateCost(used, usage.input, usage.output) + searchCost(used.provider, result.searches);
  await admin.rpc("settle_spend", {
    p_hold: hold.hold_id,
    p_message: null,
    p_provider: used.provider,
    p_model: used.id,
    p_input: usage.input,
    p_output: usage.output,
    p_cost: Number(result.cost.toFixed(6)),
  });
  return result;
}

/** The stand-in AI (local tests only) can't plan, so it gets a fixed three-question plan. */
function fakePlan(request: string): string {
  const topic = request.replace(/\s+/g, " ").slice(0, 60);
  return JSON.stringify({
    title: `Report: ${topic}`,
    questions: [`What is the latest background on ${topic}?`, `What are the latest options for ${topic}?`, `What do experts recommend lately?`],
  });
}
