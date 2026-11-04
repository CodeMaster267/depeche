import "server-only";
import { findModel, type Model } from "@/lib/ai/models";
import { fakeAi, streamReply, type Turn } from "@/lib/ai/providers";
import { makeReadable, type Fix } from "./contrast";
import { familyFriendly } from "./friendly";
import { TRY_AGAIN, builderSystem } from "./prompt";
import { cleanSpec, cleanText, textsOf, type Spec } from "./spec";

/**
 * Builds a design from a brief with the strongest model the family has a key for. The answer is
 * data (a design), which is cleaned, checked for family-friendliness and made readable before
 * anyone sees it. Nothing the model writes is ever run.
 */

/** Strongest first. Hasan asked for "a bigger model" for every build. */
export const BUILDERS = [
  "claude-fable-5-1",
  "gpt-6-astra",
  "claude-opus-5-5",
  "gemini-4-argon",
  "grok-4.7",
  "gpt-6.1-sol",
  "claude-sonnet-5-5",
  "deepseek-v4-pro",
  "gemini-3.8-flash",
  "openai/gpt-oss-120b",
];

/** The most a build's answer may be. A design is about 1,500 tokens; this leaves room. */
export const BUILD_OUTPUT = 6_000;

export function pickBuilder(keys: readonly { provider: string; models: readonly string[] | null }[]): Model | undefined {
  for (const id of BUILDERS) {
    const m = findModel(id);
    if (!m) continue;
    const key = keys.find((k) => k.provider === m.provider);
    if (key && (!key.models?.length || key.models.includes(id))) return m;
  }
  return undefined;
}

export type BuildResult =
  | { kind: "built"; spec: Spec; unmet: string[]; fixes: Fix[] }
  | { kind: "refused"; reason: string }
  | { kind: "failed"; reason: string };

export type Usage = { input: number; output: number };

/** The first {...} in a reply, parsed, or undefined. Models sometimes wrap JSON in fences or words. */
export function readJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Turns the model's answer into a result: a checked design, a refusal, or a failure. */
export function judge(answer: Record<string, unknown>, current: Spec): BuildResult {
  if (typeof answer.refuse === "string" && answer.refuse.trim()) {
    return { kind: "refused", reason: cleanText(answer.refuse, 300) ?? "That one isn't something Depeche can make." };
  }
  const cleaned = cleanSpec(answer, current);
  const { spec, fixes } = makeReadable(cleaned);
  if (!familyFriendly(...textsOf(spec))) {
    return { kind: "refused", reason: "Some of the words in that design weren't family friendly, so it wasn't kept." };
  }
  const unmet = (Array.isArray(answer.unmet) ? answer.unmet : [])
    .map((u) => cleanText(u, 200))
    .filter((u): u is string => !!u && familyFriendly(u))
    .slice(0, 5);
  return { kind: "built", spec, unmet, fixes };
}

export async function buildDesign(opts: {
  model: Model;
  apiKey: string;
  current: Spec;
  brief: string;
  personName: string;
  forSomeoneElse: boolean;
  signal: AbortSignal;
}): Promise<{ result: BuildResult; usage: Usage; model: Model }> {
  const usage: Usage = { input: 0, output: 0 };
  if (fakeAi()) return { result: fakeBuild(opts.brief, opts.current), usage: { input: 4000, output: 900 }, model: opts.model };

  const system = builderSystem(opts.current, opts.personName, opts.forSomeoneElse);
  const turns: Turn[] = [{ role: "user", text: `Brief:\n${opts.brief}` }];
  let used = opts.model;
  for (let attempt = 0; attempt < 2; attempt++) {
    let text = "";
    let reported: Usage | undefined;
    for await (const ev of streamReply({ model: opts.model, apiKey: opts.apiKey, system, turns, signal: opts.signal, maxOutput: BUILD_OUTPUT, think: false })) {
      if (ev.type === "text") text += ev.text;
      else if (ev.type === "usage") reported = { input: ev.input, output: ev.output };
      else if (ev.type === "model") used = findModel(ev.id) ?? used;
    }
    usage.input += reported?.input ?? Math.ceil((system.length + opts.brief.length) / 3);
    usage.output += reported?.output ?? Math.ceil(text.length / 3);
    const answer = readJson(text);
    if (answer) return { result: judge(answer, opts.current), usage, model: used };
    turns.push({ role: "assistant", text: text.slice(0, 4000) || "(nothing)" }, { role: "user", text: TRY_AGAIN });
  }
  return { result: { kind: "failed", reason: "The designer's answer couldn't be read." }, usage, model: used };
}

/**
 * OpenAI's moderation check is free with any OpenAI key. Returns true when it flags the text, and
 * false when it's fine or the check couldn't run (the word check and the model still apply).
 */
export async function flaggedByModeration(apiKey: string, text: string): Promise<boolean> {
  if (fakeAi()) return /moderation-test/i.test(text);
  try {
    const res = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "omni-moderation-latest", input: text.slice(0, 4000) }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { results?: { flagged?: boolean }[] };
    return !!body.results?.some((r) => r.flagged);
  } catch {
    return false;
  }
}

/**
 * The stand-in used by the browser tests (never on Vercel): words in the brief pick a design, so
 * every part of the flow can be tested without a real model.
 */
function fakeBuild(brief: string, current: Spec): BuildResult {
  const b = brief.toLowerCase();
  if (b.includes("broken answer")) return { kind: "failed", reason: "The designer's answer couldn't be read." };
  if (b.includes("refuse-test")) return { kind: "refused", reason: "That isn't family friendly, so I can't make it." };
  const answer: Record<string, unknown> = { name: "Test look", summary: "A test design." };
  if (b.includes("playful")) {
    Object.assign(answer, {
      name: "Sunny playground",
      summary: "Warm cream and coral colours, a rounded friendly font, solid coral buttons and a dotted background.",
      light: { bg: "#fff8f0", surface: "#fff1e3", soft: "#ffe6d1", fg: "#2b1a12", mute: "#7a5a48", faint: "#b89a88", line: "#f2d9c4", inv: "#c2410c", onInv: "#ffffff", accent: "#c2410c", accent2: "#a16207" },
      dark: { bg: "#1d1410", surface: "#24180f", soft: "#33231a", fg: "#fbefe6", mute: "#c9a993", faint: "#7d6352", line: "#3d2b20", inv: "#ff8a65", onInv: "#1d1410", accent: "#ff8a65", accent2: "#ffc061" },
      fonts: { body: "nunito", headings: "baloo", wordmark: "baloo" },
      buttons: "solid",
      backdrop: "dots",
      corners: "extra",
      regions: { "user-message": { background: "accent", text: "auto" }, composer: { border: "accent", borderWidth: 2 } },
      texts: { greeting: "Hey {name}!", subtitle: "What shall we dream up today?" },
    });
  }
  if (b.includes("unreadable")) {
    // Pale grey text on white: must be corrected before anyone sees it.
    answer.light = { ...current.light, fg: "#dddddd", mute: "#eeeeee" };
  }
  if (b.includes("right")) answer.layout = { ...current.layout, sidebarPhone: "right", sidebarDesktop: "right" };
  if (b.includes("memory button")) answer.shortcuts = [...current.shortcuts, { piece: "memory", place: "header", label: "My memory" }];
  if (b.includes("dark mode button")) answer.shortcuts = [...current.shortcuts, { piece: "light-dark", place: "composer" }];
  if (b.includes("hide the hint")) answer.hide = ["keyboard-hint"];
  if (b.includes("dancing")) answer.unmet = ["Make the logo dance across the screen"];
  if (b.includes("rude label")) answer.shortcuts = [{ piece: "memory", place: "header", label: "shit list" }];
  return judge(answer, current);
}
