import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDatabase, rows } from "./harness";

/**
 * Importing chats from ChatGPT, Claude and Gemini exports. The server stores each batch with
 * `import_chats` for the signed-in person; nobody else can read the result, the browser can't call
 * it or fake an import, the same chat is never imported twice, and the per-person allowance holds.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2), other: id(3) };
const F = { mine: id(101), theirs: id(102) };

let db: PGlite;

async function asServer<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return db.transaction(async (tx) => {
    await tx.exec("set local role service_role");
    return (await tx.query<T>(sql, params)).rows;
  });
}

const chat = (key: string, text = "hello", extra: Record<string, unknown> = {}) => ({
  source: "chatgpt",
  key,
  title: `Chat ${key}`,
  created_at: "2024-06-01T10:00:00.000Z",
  updated_at: "2024-06-01T10:05:00.000Z",
  messages: [
    { role: "user", text: `${text} question`, created_at: "2024-06-01T10:00:00.000Z", model: null },
    { role: "assistant", text: `${text} answer`, created_at: "2024-06-01T10:00:00.000Z", model: "gpt-4o" },
    { role: "assistant", text: "", created_at: "2024-06-01T10:01:00.000Z", model: null },
  ],
  ...extra,
});

const importAs = async (owner: string, chats: unknown[]) =>
  (await asServer<{ r: Record<string, unknown> }>("select public.import_chats($1, $2::jsonb) as r", [owner, JSON.stringify(chats)]))[0].r;

beforeAll(async () => {
  db = await freshDatabase();
  await db.exec(`
    insert into auth.users (id, email) values ('${P.hasan}', 'h@example.com'), ('${P.amir}', 'a@example.com'), ('${P.other}', 'o@example.com');
    insert into public.families (id, name, created_by) values ('${F.mine}', 'Mine', '${P.hasan}'), ('${F.theirs}', 'Theirs', '${P.hasan}');
    insert into public.profiles (id, family_id, role, is_app_owner, display_name, share_titles) values
      ('${P.hasan}', '${F.mine}', 'admin', true, 'Hasan', false),
      ('${P.amir}', '${F.mine}', 'member', false, 'Amir', true),
      ('${P.other}', '${F.theirs}', 'admin', false, 'Other', true);
  `);
});

describe("importing chats", () => {
  it("stores chats with their dates as a straight line of messages", async () => {
    expect(await importAs(P.amir, [chat("a", "boiler"), chat("b", "lahore")])).toMatchObject({ imported: 2, skipped: 0, full: false });
    const chats = await rows<{ title: string; imported_from: string; created_at: Date; updated_at: Date }>(
      db, P.amir, "select title, imported_from, created_at, updated_at from chats where owner_id = $1 order by title", [P.amir],
    );
    expect(chats.map((c) => [c.title, c.imported_from])).toEqual([["Chat a", "chatgpt"], ["Chat b", "chatgpt"]]);
    expect(chats[0].updated_at.toISOString()).toBe("2024-06-01T10:05:00.000Z");

    const msgs = await rows<{ id: string; parent_id: string | null; role: string; text: string; model: string | null; created_at: Date }>(
      db, P.amir,
      "select m.id, m.parent_id, m.role, m.content->>'text' as text, m.model, m.created_at from messages m join chats c on c.id = m.chat_id where c.title = 'Chat a' order by m.created_at",
    );
    // The empty message is dropped; equal times are nudged apart so the reply comes last.
    expect(msgs.map((m) => [m.role, m.text, m.model])).toEqual([["user", "boiler question", null], ["assistant", "boiler answer", "gpt-4o"]]);
    expect(msgs[0].parent_id).toBeNull();
    expect(msgs[1].parent_id).toBe(msgs[0].id);
    expect(msgs[1].created_at.getTime()).toBeGreaterThanOrEqual(msgs[0].created_at.getTime());
  });

  it("skips chats already imported, so importing the same export again adds nothing", async () => {
    expect(await importAs(P.amir, [chat("a"), chat("c")])).toMatchObject({ imported: 1, skipped: 1 });
    // The same id from another app, or for another person, is a different chat.
    expect(await importAs(P.amir, [chat("a", "x", { source: "claude" })])).toMatchObject({ imported: 1 });
    expect(await importAs(P.hasan, [chat("a")])).toMatchObject({ imported: 1 });
  });

  it("is private like any chat: only the owner reads the messages, an admin at most the title", async () => {
    const amirText = "select content->>'text' as t from messages where content->>'text' like 'boiler%'";
    expect(await rows(db, P.amir, amirText)).toHaveLength(2);
    expect(await rows(db, P.hasan, amirText)).toHaveLength(0);
    expect(await rows(db, P.other, amirText)).toHaveLength(0);
    await expect(rows(db, null, amirText)).rejects.toThrow(/permission denied/);
    expect(await rows(db, P.other, "select title from chats where owner_id = $1", [P.amir])).toHaveLength(0);
  });

  it("imported messages are found by search, for their owner only", async () => {
    const [{ id: chatId }] = await rows<{ id: string }>(db, P.amir, "select id from chats where title = 'Chat a' and imported_from = 'chatgpt'");
    const find = (who: string) => rows<{ text: string }>(db, who, "select text from public.search_chat($1, 'boilers')", [chatId]);
    expect((await find(P.amir)).map((r) => r.text)).toEqual(["boiler question", "boiler answer"]);
    expect(await find(P.hasan)).toEqual([]);
  });

  it("can only be run by the server, never from the browser", async () => {
    for (const who of [P.amir, null]) {
      await expect(rows(db, who, "select public.import_chats($1, '[]'::jsonb)", [P.amir])).rejects.toThrow(/permission denied/);
      await expect(rows(db, who, "select public.imported_chars($1)", [P.amir])).rejects.toThrow(/permission denied/);
    }
  });

  it("the browser can't mark its own chats as imported", async () => {
    await expect(
      as(db, P.amir, (tx) => tx.query("insert into chats (owner_id, title, imported_from, import_key) values ($1, 'fake', 'chatgpt', 'zzz')", [P.amir])),
    ).rejects.toThrow(/row-level security|permission denied/);
    await expect(
      as(db, P.amir, (tx) => tx.query("update chats set imported_from = null where owner_id = $1", [P.amir])),
    ).rejects.toThrow(/permission denied/);
    // Ordinary new chats still work.
    await as(db, P.amir, (tx) => tx.query("insert into chats (owner_id, title) values ($1, 'normal')", [P.amir]));
  });

  it("refuses odd input and unknown people", async () => {
    await expect(importAs(id(999), [chat("q")])).rejects.toThrow(/No such person/);
    await expect(importAs(P.amir, [chat("q", "x", { source: "openai" })])).rejects.toThrow(/check/);
    await expect(importAs(P.amir, Array.from({ length: 201 }, (_, i) => chat(`many${i}`)))).rejects.toThrow(/200/);
  });

  it("stops at each person's allowance and says so", async () => {
    await db.exec("create or replace function public.import_text_limit() returns bigint language sql immutable as $$ select 100::bigint $$");
    try {
      const used = Number((await asServer<{ n: string }>("select public.imported_chars($1) as n", [P.other]))[0].n);
      expect(used).toBe(0);
      // Each chat here is 2 × 13 characters; four fit in 100, the fifth doesn't.
      const r = await importAs(P.other, Array.from({ length: 6 }, (_, i) => chat(`cap${i}`, "1234567")));
      expect(r).toMatchObject({ imported: 3, full: true, limit: 100 });
      expect(await importAs(P.other, [chat("later", "1234567")])).toMatchObject({ imported: 0, full: true });
      // Deleting imported chats frees space.
      await as(db, P.other, (tx) => tx.query("delete from chats where owner_id = $1 and import_key = 'cap0'", [P.other]));
      expect(await importAs(P.other, [chat("later", "1234567")])).toMatchObject({ imported: 1 });
    } finally {
      await db.exec("create or replace function public.import_text_limit() returns bigint language sql immutable as $$ select 20000000::bigint $$");
    }
  });

  it("stops for everyone once the database is nearly full", async () => {
    await db.exec("create or replace function public.import_database_limit() returns bigint language sql immutable as $$ select 1::bigint $$");
    try {
      expect(await importAs(P.hasan, [chat("dbfull")])).toMatchObject({ imported: 0, full: true, database_full: true });
    } finally {
      await db.exec("create or replace function public.import_database_limit() returns bigint language sql immutable as $$ select 400000000::bigint $$");
    }
  });

  it("imported chats get a month from the day they were imported, then go like any chat", async () => {
    // Old original dates don't count: a fresh import is safe for a month.
    await asServer("update chats set updated_at = now() - interval '400 days' where imported_from is not null");
    const kept = await asServer<{ n: string }>("select count(*) as n from chats where imported_from is not null and kept_at > now() - interval '1 minute'");
    expect(Number(kept[0].n)).toBeGreaterThan(0);
    await asServer("select public.expire_old_chats()");
    const before = Number((await asServer<{ n: string }>("select count(*) as n from chats where imported_from is not null"))[0].n);
    expect(before).toBeGreaterThan(0);
    // Their owners are told before they go, like any chat.
    await asServer("update chats set kept_at = now() - interval '28 days' where imported_from is not null");
    expect((await rows(db, P.amir, "select title from public.my_expiring_chats(3)")).length).toBeGreaterThan(0);
    // A month after the import, unused, they're deleted.
    await asServer("update chats set kept_at = now() - interval '31 days' where imported_from is not null");
    await asServer("select public.expire_old_chats()");
    expect(await asServer("select title from chats where imported_from is not null")).toEqual([]);
  });
});
