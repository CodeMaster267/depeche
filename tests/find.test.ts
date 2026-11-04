import { describe, expect, it } from "vitest";
import { marked, plainText, searchTerms, snippet } from "@/lib/chat/find";

describe("search your chats: snippets", () => {
  it("keeps a short message whole, as plain text", () => {
    expect(snippet("**Boiler** quote: [Smith](https://x.y) was £450", "boiler")).toBe("Boiler quote: Smith was £450");
  });

  it("cuts a long message around the first search word", () => {
    const text = `${"Lorem ipsum dolor sit amet. ".repeat(20)}The boiler quote was £450. ${"More words after. ".repeat(20)}`;
    const s = snippet(text, "boiler", 120);
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
    expect(s).toContain("The boiler quote was £450.");
    expect(s.length).toBeLessThanOrEqual(122);
  });

  it("finds a plural or stemmed form, and falls back to the start", () => {
    const text = `${"x ".repeat(200)}two boilers here ${"y ".repeat(200)}`;
    expect(snippet(text, "boilers", 80)).toContain("boilers here");
    expect(snippet("a".repeat(300), "zebra", 50)).toBe(`${"a".repeat(49)}…`);
  });

  it("marks the search words, ignoring case and filler words", () => {
    expect(searchTerms("what did I say about the Boiler")).toContain("boiler");
    expect(searchTerms("what did I say about the Boiler")).not.toContain("the");
    expect(marked("New Boiler and boilers", "boiler")).toEqual([
      { text: "New ", hit: false },
      { text: "Boiler", hit: true },
      { text: " and ", hit: false },
      { text: "boiler", hit: true },
      { text: "s", hit: false },
    ]);
    expect(marked("£450 (B-12)", "B-12")).toEqual([
      { text: "£450 (", hit: false },
      { text: "B-12", hit: true },
      { text: ")", hit: false },
    ]);
  });

  it("drops code fences and markdown marks", () => {
    expect(plainText("# Title\n```ts\nconst a = 1;\n```\n- item `x`")).toBe("Title const a = 1; item x");
  });
});
