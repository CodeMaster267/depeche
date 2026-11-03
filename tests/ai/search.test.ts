import { describe, expect, it } from "vitest";
import { MAX_SEARCHES, findModel, searchCost } from "@/lib/ai/models";
import { webSource } from "@/lib/ai/sources";

describe("web search sources", () => {
  it("keeps only http and https links", () => {
    expect(webSource("https://example.com/a", "A")).toEqual({ url: "https://example.com/a", title: "A" });
    expect(webSource("http://example.com", "")).toEqual({ url: "http://example.com/", title: "example.com" });
    expect(webSource("javascript:alert(1)", "x")).toBeNull();
    expect(webSource("data:text/html,hi", "x")).toBeNull();
    expect(webSource("not a url", "x")).toBeNull();
    expect(webSource(undefined, "x")).toBeNull();
  });

  it("keeps the site Google names, since its links go through a redirect", () => {
    expect(webSource("https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", "bbc.co.uk", "bbc.co.uk")).toEqual({
      url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc",
      title: "bbc.co.uk",
      domain: "bbc.co.uk",
    });
  });
});

describe("web search fees", () => {
  it("charges each provider's per-search fee", () => {
    expect(searchCost("anthropic", 3)).toBeCloseTo(0.03);
    expect(searchCost("openai", 1)).toBeCloseTo(0.01);
    expect(searchCost("google", 2)).toBeCloseTo(0.028);
    expect(searchCost("google", -1)).toBe(0);
  });

  it("bounds what one reply's searching can cost", () => {
    expect(MAX_SEARCHES).toBeLessThanOrEqual(5);
    expect(searchCost(findModel("gemini-3.8-flash")!.provider, MAX_SEARCHES)).toBeLessThan(0.1);
  });
});
