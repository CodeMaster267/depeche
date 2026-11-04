import { describe, expect, it } from "vitest";
import { isShareToken, shareToken, snapshot } from "@/lib/chat/share";
import type { MessageRow } from "@/lib/chat/thread";

const msg = (id: string, parent: string | null, role: MessageRow["role"], content: MessageRow["content"], at: number, extra: Partial<MessageRow> = {}): MessageRow => ({
  id, chat_id: "c", parent_id: parent, role, content, status: "completed", model: null, created_at: new Date(at * 1000).toISOString(), ...extra,
});

describe("share snapshot", () => {
  it("keeps the shown conversation and leaves out costs, errors, file locations and older branches", () => {
    const rows = [
      msg("q", null, "user", { text: "Plan a trip", files: [{ path: "owner-id/secret.pdf", name: "notes.pdf", mime: "application/pdf", size: 10 }] }, 1),
      msg("old", "q", "assistant", { text: "First try" }, 2, { model: "claude-sonnet-5-5" }),
      msg("new", "q", "assistant", { text: "Second try", cost: 0.12, notice: "busy", sources: [{ url: "https://a.example", title: "A" }, { url: "javascript:alert(1)", title: "B" }], suggestions: "<b>x</b>" }, 3, { model: "claude-sonnet-5-5" }),
    ];
    const out = snapshot(rows);
    expect(out).toEqual([
      { role: "user", text: "Plan a trip", files: [{ name: "notes.pdf", mime: "application/pdf" }] },
      { role: "assistant", text: "Second try", sources: [{ url: "https://a.example", title: "A" }], model: "claude-sonnet-5-5" },
    ]);
    expect(JSON.stringify(out)).not.toContain("owner-id");
  });

  it("makes long random tokens", () => {
    const a = shareToken();
    expect(isShareToken(a)).toBe(true);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(shareToken()).not.toBe(a);
  });
});
