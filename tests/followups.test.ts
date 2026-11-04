import { describe, expect, it } from "vitest";
import { FOLLOWUPS_CLOSE, FOLLOWUPS_OPEN, MAX_QUOTE_CHARS, cleanQuote, parseFollowUps, tagFilter, withQuote } from "@/lib/chat/followups";
import { memoryFilter } from "@/lib/chat/memory";
import { formatCost } from "@/components/chat/Extras";

/** Streams `text` through a filter in chunks of `size`, as a provider would. */
function stream(text: string, size: number) {
  const f = tagFilter(FOLLOWUPS_OPEN, FOLLOWUPS_CLOSE);
  let out = "";
  for (let i = 0; i < text.length; i += size) out += f.push(text.slice(i, i + size));
  out += f.end();
  return { out, found: f.found };
}

describe("follow-up questions", () => {
  const reply = "The answer is 42.\n\n<followups>\n- Why 42?\n2. Who asked?\n</followups>";

  it("are taken out of the reply however the stream is cut", () => {
    for (const size of [1, 2, 3, 7, 11, 24, 500]) {
      const { out, found } = stream(reply, size);
      expect(out).toBe("The answer is 42.\n\n");
      expect(parseFollowUps(found)).toEqual(["Why 42?", "Who asked?"]);
    }
  });

  it("leave ordinary text with a < in it alone", () => {
    const { out, found } = stream("a < b and <fol is not a tag", 3);
    expect(out).toBe("a < b and <fol is not a tag");
    expect(found).toEqual([]);
  });

  it("still count when the reply stopped before closing the tag", () => {
    const { out, found } = stream("Done.\n<followups>\nWhat next?", 5);
    expect(out).toBe("Done.\n");
    expect(parseFollowUps(found)).toEqual(["What next?"]);
  });

  it("work alongside the memory tag", () => {
    const memory = memoryFilter();
    const f = tagFilter(FOLLOWUPS_OPEN, FOLLOWUPS_CLOSE);
    const text = "Hi.\n<remember>Likes tea.</remember>\n<followups>\nMore tea?\n</followups>";
    let out = "";
    for (let i = 0; i < text.length; i += 4) out += f.push(memory.push(text.slice(i, i + 4)));
    out += f.push(memory.end()) + f.end();
    expect(out.trim()).toBe("Hi.");
    expect(memory.suggestions).toEqual(["Likes tea."]);
    expect(parseFollowUps(f.found)).toEqual(["More tea?"]);
  });

  it("are capped at three short, distinct questions", () => {
    const long = "x".repeat(200);
    expect(parseFollowUps(['"One?"\n* Two?\n• Two?\n3) Three?\nFour?', long])).toEqual(["One?", "Two?", "Three?"]);
  });
});

describe("asking about part of an answer", () => {
  it("puts the quoted part in front of the question", () => {
    expect(withQuote("What does this mean?", "line one\nline two")).toBe(
      "About this part of your earlier answer:\n> line one\n> line two\n\nWhat does this mean?",
    );
    expect(withQuote("Plain", undefined)).toBe("Plain");
  });

  it("only takes trimmed text of a sensible length", () => {
    expect(cleanQuote(42)).toBeUndefined();
    expect(cleanQuote("   ")).toBeUndefined();
    expect(cleanQuote(" a\r\n\n\n\nb ")).toBe("a\n\nb");
    expect(cleanQuote("y".repeat(MAX_QUOTE_CHARS + 50))).toHaveLength(MAX_QUOTE_CHARS);
  });
});

describe("cost per message", () => {
  it("shows tiny amounts as more than nothing", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.00003)).toBe("<$0.0001");
    expect(formatCost(0.0012)).toBe("$0.0012");
    expect(formatCost(0.237)).toBe("$0.24");
  });
});
