import { describe, expect, it } from "vitest";
import { MAX_QUESTIONS, MAX_SOURCES, linksIn, mergeSources, parsePlan, reportPrompt } from "@/lib/research/prompts";

describe("deep research plan", () => {
  it("reads the model's JSON plan, even with words around it", () => {
    const plan = parsePlan('Sure!\n```json\n{"title": "Heat pumps", "questions": ["Cost?", " Noise? ", ""]}\n```', "heat pumps");
    expect(plan).toEqual({ title: "Heat pumps", questions: ["Cost?", "Noise?"] });
  });

  it("keeps at most five questions", () => {
    const qs = Array.from({ length: 9 }, (_, i) => `Q${i}`);
    expect(parsePlan(JSON.stringify({ title: "t", questions: qs }), "x").questions).toHaveLength(MAX_QUESTIONS);
  });

  it("falls back to researching the request itself", () => {
    expect(parsePlan("I can't do JSON today", "Best e-bikes under £2,000")).toEqual({
      title: "Best e-bikes under £2,000",
      questions: ["Best e-bikes under £2,000"],
    });
    expect(parsePlan('{"questions": []}', "x").questions).toEqual(["x"]);
  });
});

describe("deep research sources", () => {
  it("finds web links in notes and never keeps other kinds of link", () => {
    expect(linksIn("A [BBC](https://bbc.co.uk/a) and [bad](javascript:alert(1)) and [ftp](ftp://x.y)")).toEqual([
      { url: "https://bbc.co.uk/a", title: "BBC" },
    ]);
  });

  it("merges without duplicates, in order found, up to a limit", () => {
    const a = { url: "https://a.com/x", title: "A" };
    const merged = mergeSources([a], [{ url: "https://a.com/x/", title: "A again" }, { url: "https://b.com", title: "B" }]);
    expect(merged.map((s) => s.title)).toEqual(["A", "B"]);
    const many = Array.from({ length: 60 }, (_, i) => ({ url: `https://s${i}.com`, title: `S${i}` }));
    expect(mergeSources([], many)).toHaveLength(MAX_SOURCES);
  });

  it("numbers the sources for the report and leaves out failed notes", () => {
    const p = reportPrompt("q", "", "T", [{ question: "one", text: "found it" }, { question: "two", text: "", failed: true }], [
      { url: "https://a.com/", title: "A" },
    ]);
    expect(p.user).toContain("[1] A (https://a.com/)");
    expect(p.user).toContain("Question: one");
    expect(p.user).not.toContain("Question: two");
    expect(reportPrompt("q", "", "T", [], []).system).toMatch(/own knowledge/);
  });
});
