import { describe, expect, it } from "vitest";
import { MAX_COMPARE, comparedWith, toggleCompare } from "@/lib/chat/compare";
import type { MessageRow } from "@/lib/chat/thread";

const G = "11111111-1111-4111-8111-111111111111";
let clock = 0;
function reply(id: string, slot: number | null, opts: Partial<MessageRow> = {}): MessageRow {
  clock++;
  return {
    id,
    chat_id: "c",
    parent_id: "q",
    role: "assistant",
    content: { text: id, ...(slot === null ? {} : { compare: { id: G, slot } }) },
    status: "completed",
    model: null,
    created_at: `2026-11-04T01:00:${String(clock).padStart(2, "0")}Z`,
    ...opts,
  };
}

describe("comparing models", () => {
  it("lists the answers in the order the models were chosen, whatever order they finished", () => {
    const c = reply("c", 2);
    const a = reply("a", 0);
    const b = reply("b", 1);
    expect(comparedWith([c, a, b], b).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("leaves out ordinary replies, other questions and other comparisons", () => {
    const a = reply("a", 0);
    const b = reply("b", 1);
    const retry = reply("plain", null);
    const elsewhere = reply("other-q", 1, { parent_id: "q2" });
    const other = { ...reply("other-group", 2), content: { compare: { id: "22222222-2222-4222-8222-222222222222", slot: 2 } } };
    expect(comparedWith([a, b, retry, elsewhere, other], a).map((m) => m.id)).toEqual(["a", "b"]);
    expect(comparedWith([a, retry], retry)).toEqual([]);
  });

  it("shows a model's newest answer when it was asked again, but keeps the one being shown", () => {
    const a = reply("a", 0);
    const failed = reply("b-failed", 1, { status: "failed" });
    const again = reply("b-again", 1);
    expect(comparedWith([a, failed, again], a).map((m) => m.id)).toEqual(["a", "b-again"]);
    expect(comparedWith([a, failed, again], failed).map((m) => m.id)).toEqual(["a", "b-failed"]);
  });

  it("lets people pick at most three models, in the order they tapped them", () => {
    let s: string[] = [];
    for (const id of ["x", "y", "z", "w"]) s = toggleCompare(s, id);
    expect(s).toEqual(["x", "y", "z"]);
    expect(s.length).toBe(MAX_COMPARE);
    expect(toggleCompare(s, "y")).toEqual(["x", "z"]);
  });
});
