import { describe, expect, it } from "vitest";
import { aboutHeading, checkerPrompt, cleanAbout, fakeCheck, plainCheck, readJson, readVerdict, type Existing } from "@/lib/chat/memory-check";
import { memoryInstructions } from "@/lib/chat/memory";

const existing: Existing[] = [
  { id: "a", content: "Hasan's dad is 52.", about: "dad" },
  { id: "b", content: "Hasan is vegetarian.", about: "me" },
  { id: "c", content: "Hasan lives in York.", about: null },
];

describe("smart memory: reading the checker's answer", () => {
  it("ties numbers back to the memories it was shown, and ignores anything else", () => {
    const v = readVerdict({ verdict: "conflict", about: "Dad", fact: "Hasan's dad is 19.", with: [1, 7, "x", 0], question: "Is your dad 19, or is that your brother?" }, "my dad is 19", existing);
    expect(v).toEqual({ kind: "conflict", fact: "Hasan's dad is 19.", about: "dad", with: ["a"], question: "Is your dad 19, or is that your brother?" });
  });

  it("an update needs real memories to replace, or it's just new", () => {
    expect(readVerdict({ verdict: "update", fact: "Hasan lives in Leeds.", replaces: [3] }, "I moved to Leeds", existing)).toMatchObject({ kind: "update", replaces: ["c"] });
    expect(readVerdict({ verdict: "update", fact: "Hasan lives in Leeds.", replaces: [9] }, "I moved to Leeds", existing)).toMatchObject({ kind: "new" });
  });

  it("a duplicate must point at a real memory", () => {
    expect(readVerdict({ verdict: "duplicate", same: 2 }, "I'm vegetarian", existing)).toMatchObject({ kind: "duplicate", same: "b" });
    expect(readVerdict({ verdict: "duplicate", same: 12 }, "I'm vegetarian", existing)).toMatchObject({ kind: "new", fact: "I'm vegetarian" });
  });

  it("an unclear person is a question with nothing it clashes with", () => {
    const v = readVerdict({ verdict: "conflict", fact: "He is 19." }, "he is 19", existing);
    expect(v).toMatchObject({ kind: "conflict", with: [], question: "Who is this about?" });
  });

  it("unreadable answers give nothing, so the plain check is used", () => {
    expect(readVerdict(readJson("I think it's fine"), "x", existing)).toBeUndefined();
    expect(readVerdict({ verdict: "maybe" }, "x", existing)).toBeUndefined();
    expect(readJson('Sure! ```json\n{"verdict":"new"}\n```')).toEqual({ verdict: "new" });
  });

  it("keeps facts to one line and the right length", () => {
    const v = readVerdict({ verdict: "new", fact: "a\n\n".repeat(400) }, "x", existing);
    expect(v?.fact.length).toBeLessThanOrEqual(300);
    expect(v?.fact).not.toContain("\n");
  });
});

describe("smart memory: who a fact is about", () => {
  it("keeps relations lowercase and names as written", () => {
    expect(cleanAbout("Dad")).toBe("dad");
    expect(cleanAbout("my Brother Ali")).toBe("brother Ali");
    expect(cleanAbout("Ali")).toBe("Ali");
    expect(cleanAbout("Me")).toBe("me");
    expect(cleanAbout("")).toBeNull();
    expect(cleanAbout(42)).toBeNull();
  });

  it("headings on the memory page", () => {
    expect(aboutHeading("me")).toBe("You");
    expect(aboutHeading("brother Ali")).toBe("Brother Ali");
    expect(aboutHeading(null)).toBe("Other");
  });

  it("the chat model sees who each memory is about", () => {
    const text = memoryInstructions("Hasan", [{ content: "Hasan's brother is 19.", about: "brother" }, { content: "Hasan is vegetarian.", about: "me" }, "Old fact."]);
    expect(text).toContain("[Hasan's brother] Hasan's brother is 19.");
    expect(text).toContain("[Hasan] Hasan is vegetarian.");
    expect(text).toContain("- Old fact.");
    expect(text).toContain("never apply a fact about one person to another");
  });

  it("the checker is told the people already known and the rules", () => {
    const { system, user } = checkerPrompt("Hasan", "My dad is 19", existing);
    expect(system).toContain('"dad"');
    expect(system).toContain("Facts about different people never conflict");
    expect(user).toContain("1. [about: dad] Hasan's dad is 52.");
    expect(user).toContain("3. [about: unknown] Hasan lives in York.");
  });
});

describe("smart memory: fallbacks", () => {
  it("the plain check catches only an exact repeat", () => {
    expect(plainCheck("hasan is VEGETARIAN", existing)).toMatchObject({ kind: "duplicate", same: "b" });
    expect(plainCheck("Hasan's dad is 19.", existing)).toMatchObject({ kind: "new" });
  });

  it("the test stand-in covers every outcome", () => {
    expect(fakeCheck("Hasan", "My dad is 19", existing)).toMatchObject({ kind: "conflict", with: ["a"] });
    expect(fakeCheck("Hasan", "My dad is now 53", existing)).toMatchObject({ kind: "update", replaces: ["a"] });
    expect(fakeCheck("Hasan", "My brother is 19", existing)).toMatchObject({ kind: "new", about: "brother" });
    expect(fakeCheck("Hasan", "He is 19", existing)).toMatchObject({ kind: "conflict", with: [] });
    expect(fakeCheck("Hasan", "Hasan is vegetarian.", existing)).toMatchObject({ kind: "duplicate" });
  });
});
