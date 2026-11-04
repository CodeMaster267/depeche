import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { detectSource, fromChatGpt, fromClaude, fromGemini, htmlToText } from "@/lib/import/parse";
import { readExport, GEMINI_HTML, NO_CHATS } from "@/lib/import/read";
import { listZip, readZipEntry } from "@/lib/import/zip";
import { BATCH_CHATS, MAX_CHAT_CHARS, batches, finishChat, validateBatch, type ImportedChat } from "@/lib/import/types";
import { chatgpt, claude, gemini } from "./fixtures/import/samples";

const file = (data: Uint8Array | string, name: string) => {
  const blob = new Blob([typeof data === "string" ? data : (data as BlobPart)]);
  return Object.assign(blob, { name });
};

describe("ChatGPT export", () => {
  const chats = fromChatGpt(chatgpt);

  it("follows the conversation as last shown, keeps only what people saw, and merges split replies", () => {
    expect(detectSource(chatgpt)).toBe("chatgpt");
    expect(chats).toHaveLength(2);
    const [boiler] = chats;
    expect(boiler).toMatchObject({ source: "chatgpt", key: "6650a1b2-0000-4000-8000-000000000001", title: "Boiler pressure" });
    expect(boiler.messages.map((m) => [m.role, m.text, m.model])).toEqual([
      ["user", "My boiler shows 0.5 bar. Is that low?", null],
      ["assistant", "Yes, 0.5 bar is low.\n\nTop it up to about 1.5 bar.", "gpt-4o"],
    ]);
    expect(boiler.created_at).toBe("2024-06-01T10:00:00.500Z");
    expect(boiler.messages[0].created_at).toBe("2024-06-01T10:00:01.000Z");
  });

  it("notes pictures, falls back to the newest message, and fills missing times in order", () => {
    const photo = chats[1];
    expect(photo.key).toBe("6650a1b2-0000-4000-8000-000000000002");
    expect(photo.messages.map((m) => m.text)).toEqual(["[Image not imported]\n\nWhat plant is this?", "A monstera."]);
    expect(photo.messages[1].created_at >= photo.messages[0].created_at).toBe(true);
    expect(photo.messages[1].model).toBe("ChatGPT");
  });
});

describe("Claude export", () => {
  const chats = fromClaude(claude);

  it("keeps text blocks only and names attachments without their contents", () => {
    expect(detectSource(claude)).toBe("claude");
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ source: "claude", key: "c0ffee00-0000-4000-8000-000000000001", title: "Trip to Lahore" });
    expect(chats[0].messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "Plan a 3 day trip to Lahore.\n\n[Attached: flights.pdf]"],
      ["assistant", "Day 1: Badshahi Mosque.\n\nDay 2: Food Street."],
    ]);
    expect(JSON.stringify(chats)).not.toMatch(/secret pdf text|hidden thoughts/);
  });

  it("follows the newest branch when the export keeps branches", () => {
    const branched = [
      {
        uuid: "b",
        name: "Branches",
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:03:00Z",
        chat_messages: [
          { uuid: "1", parent_message_uuid: "00000000-0000-4000-8000-000000000000", sender: "human", text: "hi", created_at: "2025-01-01T00:00:00Z" },
          { uuid: "2", parent_message_uuid: "1", sender: "assistant", text: "old answer", created_at: "2025-01-01T00:01:00Z" },
          { uuid: "3", parent_message_uuid: "1", sender: "assistant", text: "new answer", created_at: "2025-01-01T00:02:00Z" },
        ],
      },
    ];
    expect(fromClaude(branched)[0].messages.map((m) => m.text)).toEqual(["hi", "new answer"]);
  });
});

describe("Gemini (Takeout) export", () => {
  it("groups prompts close in time into chats and turns reply HTML into plain text", () => {
    expect(detectSource(gemini)).toBe("gemini");
    const chats = fromGemini(gemini);
    expect(chats.map((c) => c.title)).toEqual(["what is the capital of Pakistan", "write a haiku"]);
    expect(chats[0].messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "what is the capital of Pakistan"],
      ["assistant", "The capital is **Islamabad**.\n\n- Pop: 1.2m"],
      ["user", "and its population?"],
      ["assistant", "About 1.2 million & growing."],
    ]);
    expect(chats[1].messages[1].text).toBe("Old pond\nfrog jumps in");
  });

  it("never keeps scripts or tags from reply HTML", () => {
    expect(htmlToText('<p onclick="x()">hi</p><script>alert(1)</script><img src=x onerror=alert(1)>&#60;b&#62;')).toBe("hi\n\n<b>");
  });
});

describe("reading the picked file", () => {
  it("reads the chats file out of a zip, ignoring everything else", async () => {
    const zip = zipSync({
      "chat.html": strToU8("<html></html>"),
      "conversations.json": strToU8(JSON.stringify(chatgpt)),
      "file-abc.png": new Uint8Array(5000),
    });
    const got = await readExport(file(zip, "export.zip"));
    expect(got.ok && got.source).toBe("chatgpt");
    expect(got.ok && got.chats.length).toBe(2);
  });

  it("reads uncompressed zips, plain JSON, Claude and Gemini exports", async () => {
    const stored = zipSync({ "data/conversations.json": [strToU8(JSON.stringify(claude)), { level: 0 }] });
    expect((await listZip(file(stored, "a.zip")))[0]).toMatchObject({ name: "data/conversations.json", method: 0 });
    expect(await readExport(file(stored, "claude.zip"))).toMatchObject({ ok: true, source: "claude" });
    expect(await readExport(file(JSON.stringify(claude), "conversations.json"))).toMatchObject({ ok: true, source: "claude" });
    const takeout = zipSync({ "Takeout/My Activity/Gemini Apps/MyActivity.json": strToU8(JSON.stringify(gemini)) });
    expect(await readExport(file(takeout, "takeout.zip"))).toMatchObject({ ok: true, source: "gemini" });
  });

  it("explains what to do with the wrong file", async () => {
    const html = zipSync({ "Takeout/My Activity/Gemini Apps/MyActivity.html": strToU8("<html></html>") });
    expect(await readExport(file(html, "takeout.zip"))).toEqual({ ok: false, error: GEMINI_HTML });
    expect(await readExport(file(zipSync({ "a.txt": strToU8("x") }), "x.zip"))).toEqual({ ok: false, error: NO_CHATS });
    expect(await readExport(file("hello", "notes.txt"))).toEqual({ ok: false, error: NO_CHATS });
    expect(await readExport(file("[1,2]", "x.json"))).toEqual({ ok: false, error: NO_CHATS });
  });

  it("reads one entry from a zip directly", async () => {
    const zip = zipSync({ "a.json": strToU8("[1]"), "b.json": strToU8("[2]") });
    const entries = await listZip(file(zip, "z.zip"));
    expect(new TextDecoder().decode(await readZipEntry(file(zip, "z.zip"), entries[1]))).toBe("[2]");
  });
});

const chat = (n: number, chars = 10): ImportedChat => ({
  source: "chatgpt",
  key: `k${n}`,
  title: `Chat ${n}`,
  created_at: new Date(Date.UTC(2024, 0, 1 + n)).toISOString(),
  updated_at: new Date(Date.UTC(2024, 0, 1 + n)).toISOString(),
  messages: [{ role: "user", text: "x".repeat(chars), created_at: new Date(Date.UTC(2024, 0, 1 + n)).toISOString(), model: null }],
});

describe("sending to the server", () => {
  it("sends newest chats first, in batches small enough for Vercel", () => {
    const groups = batches(Array.from({ length: 100 }, (_, i) => chat(i)));
    expect(groups.every((g) => g.length <= BATCH_CHATS)).toBe(true);
    expect(groups.flat()[0].key).toBe("k99");
    const big = batches([chat(1, 600_000), chat(2, 600_000), chat(3, 10)]);
    expect(big.map((g) => g.map((c) => c.key))).toEqual([["k3", "k2"], ["k1"]]);
  });

  it("caps very long chats so any one fits in a request", () => {
    const long = finishChat({
      source: "claude",
      key: "long",
      title: "Long",
      created_at: null,
      updated_at: null,
      messages: Array.from({ length: 40 }, (_, i) => ({
        role: i % 2 ? ("assistant" as const) : ("user" as const),
        text: "y".repeat(90_000),
        created_at: "2024-01-01T00:00:00.000Z",
        model: null,
      })),
    })!;
    expect(long.messages.reduce((n, m) => n + m.text.length, 0)).toBeLessThanOrEqual(MAX_CHAT_CHARS + 100);
    expect(long.messages.at(-1)!.text).toMatch(/too long to import/);
    expect(validateBatch({ chats: [long] })).not.toBeNull();
  });

  it("the server refuses anything the browser wouldn't have built", () => {
    const good = chat(1);
    expect(validateBatch({ chats: [good] })).toEqual([good]);
    expect(validateBatch({ chats: [] })).toBeNull();
    expect(validateBatch({ chats: Array.from({ length: BATCH_CHATS + 1 }, (_, i) => chat(i)) })).toBeNull();
    expect(validateBatch({ chats: [{ ...good, source: "openai" }] })).toBeNull();
    expect(validateBatch({ chats: [{ ...good, messages: [{ ...good.messages[0], role: "system" }] }] })).toBeNull();
    expect(validateBatch({ chats: [{ ...good, messages: [{ ...good.messages[0], text: "z".repeat(100_001) }] }] })).toBeNull();
    expect(validateBatch({ chats: [{ ...good, created_at: "yesterday" }] })).toBeNull();
    expect(validateBatch({ chats: [{ ...good, owner_id: "someone-else" }] })).toEqual([good]);
  });
});
