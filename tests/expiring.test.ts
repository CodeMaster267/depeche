import { describe, expect, it } from "vitest";
import { whenDeleted } from "@/lib/chat/expiring";

describe("when a chat will be deleted", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
  it("says it plainly", () => {
    expect(whenDeleted(at(-2), now)).toBe("Deleted at the next clean-up");
    expect(whenDeleted(at(0), now)).toBe("Deleted at the next clean-up");
    expect(whenDeleted(at(5), now)).toBe("Deleted tomorrow");
    expect(whenDeleted(at(30), now)).toBe("Deleted in 2 days");
    expect(whenDeleted(at(60), now)).toBe("Deleted in 3 days");
  });
});
