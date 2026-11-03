import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MODELS, PROVIDERS, canSearch, findModel, modelsFor, searchCost } from "@/lib/ai/models";

vi.mock("server-only", () => ({}));

const { streamReply, ProviderError, groqTool, stripGroqMarks } = await import("@/lib/ai/providers");

async function run(model: string, text: string, search = true) {
  const events = [];
  for await (const ev of streamReply({
    model: findModel(model)!,
    apiKey: "test-key",
    system: "",
    turns: [{ role: "user", text }],
    signal: new AbortController().signal,
    search,
  })) events.push(ev);
  return events;
}

describe("Groq", () => {
  beforeAll(() => vi.stubEnv("DEPECHE_FAKE_AI", "1"));
  afterAll(() => vi.unstubAllEnvs());

  it("is a provider with its free-tier models, of which GPT-OSS can search", () => {
    expect(PROVIDERS.map((p) => p.id)).toContain("groq");
    expect(modelsFor([{ provider: "groq", models: null }]).map((m) => m.id)).toEqual([
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "qwen/qwen3.8-27b",
    ]);
    expect(MODELS.filter((m) => m.provider === "groq").every((m) => m.price.input > 0)).toBe(true);
    expect(canSearch(findModel("openai/gpt-oss-120b"))).toBe(true);
    expect(canSearch(findModel("openai/gpt-oss-20b"))).toBe(true);
    expect(canSearch(findModel("qwen/qwen3.8-27b"))).toBe(false);
    expect(canSearch(findModel("gemini-3.8-flash"))).toBe(true);
    expect(searchCost("groq", 3)).toBeCloseTo(0.015);
  });

  it("GPT-OSS searches when asked; Qwen answers without searching", async () => {
    const searched = await run("openai/gpt-oss-120b", "latest news");
    expect(searched.some((e) => e.type === "sources")).toBe(true);
    const plain = await run("qwen/qwen3.8-27b", "latest news");
    expect(plain.some((e) => e.type === "searching" || e.type === "sources")).toBe(false);
    expect(plain.at(-1)?.type).toBe("usage");
  });

  it("drops Groq's citation marks, even when one is split across chunks", () => {
    expect(stripGroqMarks("Paris is the capital【0†L3-L5】.")).toEqual({ out: "Paris is the capital.", rest: "" });
    const first = stripGroqMarks("It rained【2†L");
    expect(first).toEqual({ out: "It rained", rest: "【2†L" });
    expect(stripGroqMarks(first.rest + "1-L4】 today.")).toEqual({ out: " today.", rest: "" });
    expect(stripGroqMarks("a 【 bracket that never closes " + "x".repeat(50))).toEqual({
      out: "a 【 bracket that never closes " + "x".repeat(50),
      rest: "",
    });
  });

  it("reads browser searches and their pages, counting each search once", () => {
    const seen = new Set<string>();
    const sources: { url: string; title: string }[] = [];
    const tool = {
      index: 0,
      type: "search",
      arguments: '{"query":"weather in Paris"}',
      search_results: { results: [{ title: "Météo", url: "https://meteo.fr/paris" }, { title: "bad", url: "javascript:alert(1)" }] },
    };
    expect(groqTool(tool, seen, sources)).toEqual({ searched: true, query: "weather in Paris" });
    expect(groqTool(tool, seen, sources)).toEqual({ searched: false });
    expect(groqTool({ index: 1, type: "open", arguments: '{"id":3}' }, seen, sources).searched).toBe(false);
    expect(sources).toEqual([{ url: "https://meteo.fr/paris", title: "Météo" }]);
  });

  it("lets the sibling model answer when one model's free-tier limit is reached", async () => {
    const events = await run("openai/gpt-oss-120b", "ratelimit please");
    expect(events[0]).toEqual({ type: "model", id: "openai/gpt-oss-20b" });
    expect(events[1]).toEqual({
      type: "notice",
      text: "GPT-OSS 120B (Groq) reached its free-tier limit, so GPT-OSS 20B (Groq) answered instead.",
    });
    expect(events.some((e) => e.type === "text")).toBe(true);
  });

  it("says plainly when the limit is reached on both, with Groq's own words", async () => {
    const started = Date.now();
    const error = await run("openai/gpt-oss-20b", "ratelimitall").catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toMatch(/^Groq's free tier allows only so much a minute, and that's used up\. Try again in 3 seconds\./);
    expect(error.message).toContain('(Groq said: "Rate limit reached for model');
    // A used-up allowance isn't retried with pauses like a busy server.
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
