import { describe, expect, it } from "vitest";
import { cleanInstruction, personalInstructions } from "@/lib/chat/instructions";

describe("personal instructions in the prompt", () => {
  it("quotes both parts in tags, under the person's name", () => {
    const p = personalInstructions("Amir", { about_me: "I'm 15.", answer_style: "Short answers.", enabled: true });
    expect(p).toContain("Amir wrote these personal instructions");
    expect(p).toContain("<about_me>\nI'm 15.\n</about_me>");
    expect(p).toContain("<how_to_answer>\nShort answers.\n</how_to_answer>");
  });

  it("leaves out an empty part", () => {
    const p = personalInstructions("Amir", { about_me: "  ", answer_style: "Short answers.", enabled: true });
    expect(p).not.toContain("<about_me>");
    expect(p).toContain("<how_to_answer>");
  });

  it("says nothing when switched off, empty or missing", () => {
    expect(personalInstructions("Amir", { about_me: "I'm 15.", answer_style: "", enabled: false })).toBe("");
    expect(personalInstructions("Amir", { about_me: "", answer_style: "\n", enabled: true })).toBe("");
    expect(personalInstructions("Amir", null)).toBe("");
  });

  it("tidies spacing but keeps the person's lines", () => {
    expect(cleanInstruction("  one  \r\n\r\n\r\n\r\ntwo\n")).toBe("one\n\ntwo");
  });
});
