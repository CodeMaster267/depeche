import { describe, expect, it } from "vitest";
import { MAX_OUTPUT, MIN_OUTPUT, inputTokensUpperBound, planReply } from "@/lib/ai/budget";
import { estimateCost, findModel } from "@/lib/ai/models";

const flash = findModel("gemini-3.8-flash")!;
const lite = findModel("gemini-3.5-flash-lite")!;
const sonnet = findModel("claude-sonnet-5-5")!;

describe("spending holds", () => {
  it("overestimate input tokens, more so for text that isn't plain English", () => {
    const english = "The quick brown fox jumps over the lazy dog. ".repeat(100);
    expect(inputTokensUpperBound([english])).toBeGreaterThan(english.length / 4);
    const japanese = "日本語のテキストです。".repeat(100);
    expect(inputTokensUpperBound([japanese])).toBeGreaterThanOrEqual(japanese.length);
  });

  it("reserve enough for the longest reply at the dearest model that might answer", () => {
    const plan = planReply([flash, lite], 1000);
    // Google's thinking counts twice; Flash is the dearer of the two.
    expect(plan.want).toBeCloseTo((1000 * 1.5 + MAX_OUTPUT * 7.5 * 2) / 1e6);
    expect(plan.maxOutput(plan.want)).toBe(MAX_OUTPUT);
    // Any reply that fits in the hold costs no more than it, whichever model answers.
    for (const m of [flash, lite]) expect(estimateCost(m, 1000, MAX_OUTPUT)).toBeLessThanOrEqual(plan.want);
  });

  it("cut the reply's length to fit a smaller hold, and say when it isn't worth starting", () => {
    const plan = planReply([sonnet], 2000);
    const granted = 0.01;
    const out = plan.maxOutput(granted);
    expect(out).toBeLessThan(MAX_OUTPUT);
    expect(estimateCost(sonnet, 2000, out)).toBeLessThanOrEqual(granted);
    expect(plan.need).toBeCloseTo((2000 * 2 + MIN_OUTPUT * 10) / 1e6);
    expect(plan.maxOutput(0)).toBe(0);
  });

  it("add web search fees and the pages searches read", () => {
    const plain = planReply([sonnet], 1000);
    const searching = planReply([sonnet], 1000, { extraUsd: 0.05, extraInputTokens: 60_000 });
    // Input is held at Claude's cache write price ($2.50 per million on Sonnet), as it may all be cached.
    expect(searching.want - plain.want).toBeCloseTo(0.05 + (60_000 * 2.5) / 1e6);
  });
});
