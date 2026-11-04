import { describe, expect, it } from "vitest";
import { thinkingClock, thoughtFor } from "@/lib/chat/activity";

describe("thinking time", () => {
  it("is worded briefly", () => {
    expect(thoughtFor(undefined)).toBe("Thought for a moment");
    expect(thoughtFor(400)).toBe("Thought for a moment");
    expect(thoughtFor(12_400)).toBe("Thought for 12s");
    expect(thoughtFor(60_000)).toBe("Thought for 1m");
    expect(thoughtFor(65_200)).toBe("Thought for 1m 5s");
  });

  it("adds up separate spells of thinking and ignores the writing between them", () => {
    let now = 0;
    const clock = thinkingClock(() => now);
    clock.thinking();
    now = 3000;
    clock.thinking(); // still the same spell
    now = 4000;
    clock.stopped();
    now = 9000; // writing or searching
    clock.thinking();
    now = 10_500;
    clock.stopped();
    clock.stopped();
    expect(clock.ms).toBe(5500);
  });
});
