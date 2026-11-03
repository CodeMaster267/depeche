import { describe, expect, it } from "vitest";
import { normaliseMaths } from "@/lib/markdown";
import { activePath, titleFrom, type MessageRow } from "@/lib/chat/thread";

describe("maths in replies", () => {
  it("turns \\( \\) and \\[ \\] into the dollar forms", () => {
    expect(normaliseMaths("so \\(x^2\\) and \\[y = 1\\]")).toBe("so $x^2$ and \n$$\ny = 1\n$$\n");
  });
  it("keeps money as money", () => {
    expect(normaliseMaths("It costs $5 and $10.50, or $1,000.")).toBe("It costs \\$5 and \\$10.50, or \\$1,000.");
  });
  it("leaves real maths alone", () => {
    expect(normaliseMaths("$2x + 1$ and $5$")).toBe("$2x + 1$ and $5$");
  });
  it("never touches code", () => {
    const code = "```\nprint('$5')\n\\(x\\)\n```";
    expect(normaliseMaths(code)).toBe(code);
    expect(normaliseMaths("`$5`")).toBe("`$5`");
  });
});

describe("conversation", () => {
  const m = (id: string, parent: string | null, at: number): MessageRow => ({
    id, chat_id: "c", parent_id: parent, role: "user", content: {}, status: "completed", model: null,
    created_at: new Date(2026, 0, 1, 0, 0, at).toISOString(),
  });
  it("shows the newest branch when a reply was regenerated", () => {
    const path = activePath([m("q", null, 1), m("a1", "q", 2), m("a2", "q", 3)]);
    expect(path.map((x) => x.id)).toEqual(["q", "a2"]);
  });
  it("titles chats from the first line", () => {
    expect(titleFrom("  Hello there\nmore")).toBe("Hello there");
    expect(titleFrom("word ".repeat(30)).length).toBeLessThanOrEqual(61);
  });
});

describe("modelsFor", () => {
  it("offers a provider's models once it has a key, narrowed to what the key can use", async () => {
    const { modelsFor } = await import("@/lib/ai/models");
    const ids = (keys: Parameters<typeof modelsFor>[0]) => modelsFor(keys).map((m) => m.id);
    expect(ids([])).toEqual([]);
    expect(ids([{ provider: "google", models: null }])).toEqual(["gemini-4-argon", "gemini-3.8-flash", "gemini-3.5-flash-lite"]);
    expect(ids([{ provider: "google", models: ["gemini-3.8-flash"] }])).toEqual(["gemini-3.8-flash"]);
    expect(ids([{ provider: "google", models: [] }])).toHaveLength(3);
  });
});

describe("memory suggestions in a streamed reply", () => {
  it("are taken out of the text, even when the tag arrives in pieces", async () => {
    const { memoryFilter } = await import("@/lib/chat/memory");
    const f = memoryFilter();
    const chunks = ["Noted, I'll keep that in mind.\n\n<rem", "ember>Hasan is vege", "tarian.</reme", "mber>"];
    const shown = chunks.map((c) => f.push(c)).join("") + f.end();
    expect(shown).toBe("Noted, I'll keep that in mind.\n\n");
    expect(f.suggestions).toEqual(["Hasan is vegetarian."]);
  });

  it("leave ordinary angle brackets alone", async () => {
    const { memoryFilter } = await import("@/lib/chat/memory");
    const f = memoryFilter();
    const shown = ["Use a < b and <re", "d> tags, then <"].map((c) => f.push(c)).join("") + f.end();
    expect(shown).toBe("Use a < b and <red> tags, then <");
    expect(f.suggestions).toEqual([]);
  });
});
