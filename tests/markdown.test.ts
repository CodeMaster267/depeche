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
