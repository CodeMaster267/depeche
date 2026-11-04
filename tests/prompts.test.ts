import { describe, expect, it } from "vitest";
import { blanksIn, fillBlanks, promptTitle } from "@/lib/chat/prompts";
import { canThinkHarder } from "@/lib/ai/models";
import { draftKey, nextQueued, type Queued } from "@/lib/chat/composer";

describe("saved prompt blanks", () => {
  it("are found once each, in order", () => {
    expect(blanksIn("Translate {{text}} into {{ language }}. Keep {{Text}} short.")).toEqual(["text", "language"]);
    expect(blanksIn("No blanks here, {not one} or {{}}")).toEqual([]);
  });

  it("are filled with what was typed, and kept when left empty", () => {
    const body = "Translate {{text}} into {{language}}. Again: {{ TEXT }}";
    expect(fillBlanks(body, { text: "hello", language: "  Urdu " })).toBe("Translate hello into Urdu. Again: hello");
    expect(fillBlanks(body, { text: "hi", language: "" })).toBe("Translate hi into {{language}}. Again: hi");
  });

  it("get a title from the text when none is typed", () => {
    expect(promptTitle("", "  Summarise this\nmore")).toBe("Summarise this");
    expect(promptTitle(" Mine ", "x")).toBe("Mine");
    expect(promptTitle("", "a".repeat(100))).toHaveLength(80);
  });
});

describe("think harder", () => {
  it("is offered where the provider lets Depeche raise reasoning effort", () => {
    expect(canThinkHarder({ id: "claude-sonnet-5-5", provider: "anthropic" })).toBe(true);
    expect(canThinkHarder({ id: "gpt-6.1-sol", provider: "openai" })).toBe(true);
    expect(canThinkHarder({ id: "gemini-3.8-flash", provider: "google" })).toBe(true);
    expect(canThinkHarder({ id: "openai/gpt-oss-120b", provider: "groq" })).toBe(true);
    expect(canThinkHarder({ id: "qwen/qwen3.8-27b", provider: "groq" })).toBe(false);
    expect(canThinkHarder({ id: "deepseek-v4-pro", provider: "deepseek" })).toBe(false);
    expect(canThinkHarder({ id: "grok-4.7", provider: "xai" })).toBe(false);
    expect(canThinkHarder(undefined)).toBe(false);
  });
});

describe("composer", () => {
  it("keeps drafts per person and per chat", () => {
    expect(draftKey("u1", "c1")).not.toBe(draftKey("u2", "c1"));
    expect(draftKey("u1", null)).toBe("depeche:draft:u1:new");
  });

  it("sends queued messages in order, and only after a reply finished well", () => {
    const q: Queued[] = [
      { id: "a", text: "one", files: [] },
      { id: "b", text: "two", files: [] },
    ];
    expect(nextQueued(q, "completed")?.id).toBe("a");
    expect(nextQueued(q, "stopped")).toBeUndefined();
    expect(nextQueued(q, "failed")).toBeUndefined();
    expect(nextQueued([], "completed")).toBeUndefined();
  });
});
