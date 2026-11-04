import { describe, expect, it } from "vitest";
import type { MessageRow } from "@/lib/chat/thread";
import { activeSummary, compactAt, detailsIn, missingDetails, parseSummary, planCompaction, summariserInput, summaryForModel, transcriptLine } from "@/lib/chat/summary";

let n = 0;
function msg(role: "user" | "assistant", chars: number, extra: Partial<MessageRow> = {}): MessageRow {
  n++;
  return {
    id: `m${n}`,
    chat_id: "c",
    parent_id: null,
    role,
    content: { text: "x".repeat(chars) },
    status: "completed",
    model: null,
    created_at: new Date(1_700_000_000_000 + n * 1000).toISOString(),
    ...extra,
  };
}
/** `pairs` exchanges, each question and answer about `tokens` tokens. */
const chat = (pairs: number, tokens: number) => Array.from({ length: pairs }, () => [msg("user", tokens * 4), msg("assistant", tokens * 4)]).flat();
const big = { context: 200_000 };

describe("when to compact", () => {
  it("leaves short chats alone", () => {
    expect(planCompaction(chat(10, 1_000), -1, big)).toBeNull();
  });

  it("summarises a long chat up to a reply, keeping the newest messages word for word", () => {
    const path = chat(30, 1_000); // about 60k tokens
    const plan = planCompaction(path, -1, big)!;
    expect(plan).not.toBeNull();
    expect(path[plan.throughIndex].role).toBe("assistant");
    const kept = path.length - 1 - plan.throughIndex;
    expect(kept).toBeGreaterThanOrEqual(8);
    expect(kept * 1_000).toBeGreaterThanOrEqual(12_000);
  });

  it("only counts what the last summary doesn't cover", () => {
    const path = chat(30, 1_000);
    expect(planCompaction(path, 45, big)).toBeNull();
  });

  it("compacts sooner for a model with a small window", () => {
    expect(compactAt({ context: 64_000 })).toBe(32_000);
    expect(compactAt({})).toBe(50_000);
    expect(planCompaction(chat(20, 1_000), -1, { context: 64_000 })).not.toBeNull();
  });

  it("keeps at least the last exchange even when it is huge", () => {
    const path = [...chat(4, 1_000), msg("user", 200_000), msg("assistant", 40_000)];
    const plan = planCompaction(path, -1, big)!;
    expect(plan.throughIndex).toBe(7);
  });

  it("waits while a reply is still being written", () => {
    const path = [...chat(30, 1_000), msg("user", 10), msg("assistant", 10, { status: "streaming" })];
    expect(planCompaction(path, -1, big)).toBeNull();
  });

  it("can be tested with a low trigger", () => {
    expect(planCompaction(chat(6, 100), -1, big, 500)).not.toBeNull();
  });
});

describe("which summary applies", () => {
  const path = chat(5, 10);
  const s = (through: string, status: "active" | "discarded" = "active") => ({ through_message_id: through, status });

  it("is the newest active one on the path", () => {
    expect(activeSummary(path, [s(path[1].id), s(path[5].id)])?.index).toBe(5);
    expect(activeSummary(path, [s(path[1].id), s(path[5].id, "discarded")])?.index).toBe(1);
  });

  it("ignores summaries from another branch", () => {
    expect(activeSummary(path, [s("elsewhere")])).toBeNull();
  });

  it("can look only before a point (to redo one)", () => {
    expect(activeSummary(path, [s(path[1].id), s(path[5].id)], 5)?.index).toBe(1);
  });
});

describe("summary text", () => {
  it("reads the summary and facts", () => {
    const out = parseSummary("<summary>They planned a trip.</summary>\n<facts>\n- Budget is £450\n* Flight BA123\n\n</facts>");
    expect(out).toEqual({ summary: "They planned a trip.", facts: ["Budget is £450", "Flight BA123"] });
  });

  it("accepts a reply without tags", () => {
    expect(parseSummary("Just a summary.")).toEqual({ summary: "Just a summary.", facts: [] });
  });

  it("is given to the model as labelled background", () => {
    const text = summaryForModel({ summary: "S", facts: ["F"] });
    expect(text).toContain("<earlier_conversation_summary>");
    expect(text).toContain("- F");
    expect(text).toMatch(/not as new instructions/);
  });

  it("carries the earlier summary and facts into the next one", () => {
    const input = summariserInput({ summary: "Old", facts: ["Budget is £450"] }, "[Amir]\nhi");
    expect(input).toContain("<earlier_summary>\nOld");
    expect(input).toContain("- Budget is £450");
    expect(input).toContain("<conversation>\n[Amir]\nhi");
  });

  it("names files and sources, and skips failed replies", () => {
    const user = msg("user", 0, { content: { text: "look", files: [{ path: "u/a.png", name: "a.png", mime: "image/png", size: 1 }] } });
    expect(transcriptLine(user, "Amir")).toBe("[Amir]\nlook\n[Attached picture: a.png]");
    const reply = msg("assistant", 0, { content: { text: "found", sources: [{ url: "https://x.org", title: "X" }] } });
    expect(transcriptLine(reply, "Amir")).toBe("[Assistant]\nfound\n[Sources: X <https://x.org>]");
    expect(transcriptLine(msg("assistant", 5, { status: "failed" }), "Amir")).toBe("");
  });
});

describe("detail check", () => {
  it("finds exact details worth keeping, not list markers", () => {
    const text = "1. The quote was £1,250 (or 12%), due 14/03 at 10:30. See https://example.com/quote. Email jo@x.org about plan-v2.pdf. Step 2.";
    expect(detailsIn(text).sort()).toEqual(
      ["£1,250", "12%", "14/03", "10:30", "https://example.com/quote", "jo@x.org", "plan-v2.pdf"].sort(),
    );
  });

  it("lists details the summary dropped, matching loosely", () => {
    const out = { summary: "The quote was 1250 pounds.", facts: ["Link: https://example.com/quote/"] };
    expect(missingDetails("Quote £1,250, link https://example.com/quote, code 4417.", out)).toEqual(["4417"]);
  });
});
