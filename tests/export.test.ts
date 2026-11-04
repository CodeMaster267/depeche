import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { chatMarkdown, exportEntries, memoriesMarkdown, safeName, uniqueNamer, usageCsv, zipEntries, type ExportData, type ExportMessage } from "@/lib/export/archive";

const me = "00000000-0000-4000-8000-000000000001";
const msg = (id: string, parent: string | null, role: "user" | "assistant", text: string, at: string, extra: Partial<ExportMessage> = {}): ExportMessage => ({
  id, chat_id: "c1", parent_id: parent, role, content: { text }, status: "completed", model: role === "assistant" ? "gpt-x" : null, created_at: at, ...extra,
});

const messages: ExportMessage[] = [
  msg("m1", null, "user", "Hello", "2026-11-03T10:00:00Z", { content: { text: "Hello", files: [{ path: `${me}/a/photo.jpg`, name: "photo.jpg", mime: "image/jpeg", size: 3 }] } }),
  msg("m2", "m1", "assistant", "First answer", "2026-11-03T10:00:05Z"),
  msg("m3", "m1", "assistant", "Better answer", "2026-11-03T10:01:00Z", { content: { text: "Better answer", sources: [{ url: "https://example.com", title: "Example" }] } }),
];

const data: ExportData = {
  exportedAt: "2026-11-03T12:00:00Z",
  profile: { email: "me@example.com", display_name: "Me" },
  chats: [
    { id: "c1", title: "Trip / plans?", model: null, pinned: false, archived_at: null, created_at: "2026-11-03T10:00:00Z", updated_at: "2026-11-03T10:01:00Z" },
    { id: "c2", title: "Trip / plans?", model: null, pinned: false, archived_at: null, created_at: "2026-11-03T11:00:00Z", updated_at: "2026-11-03T11:00:00Z" },
  ],
  messages,
  memories: [
    { id: "x", content: "Likes tea", status: "active", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" },
    { id: "y", content: "Lives in\nLondon", status: "suggested", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" },
  ],
  usage: [{ created_at: "2026-11-03T10:00:05Z", provider: "openai", model: "gpt, x", input_tokens: 10, output_tokens: 20, cost_usd: "0.000100", message_id: "m2" }],
};

describe("export", () => {
  it("makes file names safe and unique", () => {
    expect(safeName('a/b\\c:d*e?"f<g>h|')).toBe("a b c d e f g h");
    expect(safeName("  ..  ")).toBe("untitled");
    const name = uniqueNamer();
    expect([name("a.md"), name("A.md"), name("a.md"), name("b")]).toEqual(["a.md", "A (2).md", "a (3).md", "b"]);
  });

  it("writes the conversation as last shown, with files and sources", () => {
    const md = chatMarkdown(data.chats[0], messages, new Map([[`${me}/a/photo.jpg`, "../files/photo.jpg"]]));
    expect(md).toContain("# Trip / plans?");
    expect(md).toContain("**You** · 2026-11-03 10:00 UTC");
    expect(md).toContain("Better answer");
    expect(md).not.toContain("First answer"); // the earlier version is in chats.json
    expect(md).toContain("- [photo.jpg](../files/photo.jpg)");
    expect(md).toContain("- [Example](https://example.com)");
    expect(chatMarkdown(data.chats[0], messages, new Map())).toContain("- photo.jpg (no longer stored)");
    expect(chatMarkdown(data.chats[0], messages)).toContain("- photo.jpg\n");
  });

  it("lists memories by status and quotes CSV cells", () => {
    expect(memoriesMarkdown(data.memories)).toBe("# Memories\n\n## Remembered\n\n- Likes tea\n\n## Suggested, not answered yet\n\n- Lives in London\n");
    expect(memoriesMarkdown([])).toContain("No memories.");
    expect(usageCsv(data.usage).split("\n")[1]).toBe('2026-11-03T10:00:05Z,openai,"gpt, x",10,20,0.000100,m2');
  });

  it("zips everything into one folder that opens anywhere", () => {
    const files = [
      { ref: { path: `${me}/a/photo.jpg`, name: "photo.jpg", mime: "image/jpeg", size: 3 }, data: new Uint8Array([1, 2, 3]) },
      { ref: { path: `${me}/b/gone.pdf`, name: "gone.pdf", mime: "application/pdf", size: 3 }, data: null },
    ];
    const out = unzipSync(zipEntries(exportEntries(data, files), "depeche-export-2026-11-03"));
    expect(Object.keys(out).sort()).toEqual(
      [
        "README.txt", "chats.json", "chats/2026-11-03 Trip plans.md", "chats/2026-11-03 Trip plans (2).md",
        "files/photo.jpg", "memories.json", "memories.md", "profile.json", "usage.csv",
      ].map((p) => `depeche-export-2026-11-03/${p}`).sort(),
    );
    expect([...out["depeche-export-2026-11-03/files/photo.jpg"]]).toEqual([1, 2, 3]);
    const chats = JSON.parse(strFromU8(out["depeche-export-2026-11-03/chats.json"]));
    expect(chats[0].messages.map((m: ExportMessage) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(chats[1].messages).toEqual([]);
    expect(JSON.parse(strFromU8(out["depeche-export-2026-11-03/profile.json"]))).toEqual(data.profile);
  });
});
