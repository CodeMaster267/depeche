import type { Model } from "@/lib/ai/models";

/**
 * Hard spending caps. Before a reply starts, the server reserves the most it could cost, and the
 * database refuses if that would take the person past their monthly limit (counting every other
 * reply still running). The reply's length is then capped to fit what was reserved, so even one
 * long, expensive reply cannot overshoot. Afterwards the hold is swapped for the real cost.
 */

/** The longest reply Depeche ever asks for. */
export const MAX_OUTPUT = 32_000;
/** Below this many output tokens a reply isn't worth starting. */
export const MIN_OUTPUT = 400;

/**
 * An upper bound on the input tokens for some text. English averages about four characters per
 * token, but code, numbers and other scripts use more tokens, so this assumes the worst: one token
 * per two and a half plain characters, one per character for everything else, plus overhead.
 */
export function inputTokensUpperBound(texts: readonly string[]): number {
  let tokens = 0;
  for (const t of texts) {
    let ascii = 0;
    let other = 0;
    for (const ch of t) {
      if (ch.charCodeAt(0) < 128) ascii++;
      else other++;
    }
    tokens += Math.ceil(ascii / 2.5) + other + 8;
  }
  return tokens + 50;
}

/**
 * Prices used for the hold: the dearest of the chosen model and any model that might answer for
 * it when it's busy. Google's models can also think before answering, and thinking is billed as
 * output on top of the reply's own limit, so it is counted twice for Google.
 */
function worstPrices(models: readonly Model[]) {
  const input = Math.max(...models.map((m) => m.price.input));
  const output = Math.max(...models.map((m) => m.price.output * (m.provider === "google" ? 2 : 1)));
  return { input: input / 1_000_000, output: output / 1_000_000 };
}

export type Plan = { want: number; need: number; maxOutput: (granted: number) => number };

/**
 * What to reserve for one reply, and how long the reply may be for a given reservation. `extra`
 * covers web searches: a fee per search and the pages they bring back as input.
 */
export function planReply(
  models: readonly Model[],
  inputTokens: number,
  extra: { extraUsd?: number; extraInputTokens?: number } = {},
): Plan {
  const p = worstPrices(models);
  const inputCost = (inputTokens + (extra.extraInputTokens ?? 0)) * p.input + (extra.extraUsd ?? 0);
  return {
    want: inputCost + MAX_OUTPUT * p.output,
    need: inputCost + MIN_OUTPUT * p.output,
    maxOutput: (granted) => Math.max(0, Math.min(MAX_OUTPUT, Math.floor((granted - inputCost) / p.output))),
  };
}
