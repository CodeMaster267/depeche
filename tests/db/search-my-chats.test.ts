import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDatabase, rows } from "./harness";

/**
 * Search your chats (search_my_chats): the search box above the chat list, which looks inside
 * messages. Hasan owns the app and is admin of family A, where Amir is a member who shares chat
 * titles with his admin. Bea is admin of family B. Only Amir may ever find Amir's words.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2), bea: id(3) };
const F = { a: id(101), b: id(102) };
const C = { boiler: id(201), garden: id(202), old: id(203), hasan: id(204) };
const M = { q1: id(301), a1: id(302), q2: id(303), g1: id(304), g2: id(305), old: id(306), sys: id(307), h1: id(308) };

let db: PGlite;

const search = (who: string | null, query: string) =>
  rows<{ chat_id: string; message_id: string; role: string; text: string }>(
    db,
    who,
    "select chat_id, message_id, role, text from public.search_my_chats($1, 20)",
    [query],
  );

beforeAll(async () => {
  db = await freshDatabase();
  await db.exec(`
    insert into auth.users (id, email) values
      ('${P.hasan}', 'hasan@example.com'), ('${P.amir}', 'amir@example.com'), ('${P.bea}', 'bea@example.com');
    insert into public.families (id, name, created_by) values
      ('${F.a}', 'Family A', '${P.hasan}'), ('${F.b}', 'Friends B', '${P.hasan}');
    insert into public.profiles (id, family_id, role, is_app_owner, display_name, share_titles) values
      ('${P.hasan}', '${F.a}', 'admin', true, 'Hasan', false),
      ('${P.amir}', '${F.a}', 'member', false, 'Amir', true),
      ('${P.bea}', '${F.b}', 'admin', false, 'Bea', false);
    insert into public.chats (id, owner_id, title, archived_at, updated_at) values
      ('${C.boiler}', '${P.amir}', 'House', null, now() - interval '1 day'),
      ('${C.garden}', '${P.amir}', 'Garden', null, now()),
      ('${C.old}', '${P.amir}', 'Archived', now(), now()),
      ('${C.hasan}', '${P.hasan}', 'Mine', null, now());
    insert into public.messages (id, chat_id, owner_id, parent_id, role, content, created_at) values
      ('${M.q1}', '${C.boiler}', '${P.amir}', null, 'user', '{"text":"The boiler quote from Smith & Sons was £450 for the combi."}', now() - interval '5 min'),
      ('${M.a1}', '${C.boiler}', '${P.amir}', '${M.q1}', 'assistant', '{"text":"That is a fair price for replacing boilers."}', now() - interval '4 min'),
      ('${M.q2}', '${C.boiler}', '${P.amir}', '${M.a1}', 'user', '{"text":"My reference number is B-12/77."}', now() - interval '3 min'),
      ('${M.g1}', '${C.garden}', '${P.amir}', null, 'user', '{"text":"Should the boiler cupboard hold garden tools?"}', now() - interval '2 min'),
      ('${M.g2}', '${C.garden}', '${P.amir}', '${M.g1}', 'assistant', '{"text":"Keep tools away from it."}', now() - interval '1 min'),
      ('${M.old}', '${C.old}', '${P.amir}', null, 'user', '{"text":"Archived boiler chat."}', now()),
      ('${M.sys}', '${C.garden}', '${P.amir}', null, 'system', '{"text":"zebra system note"}', now()),
      ('${M.h1}', '${C.hasan}', '${P.hasan}', null, 'user', '{"text":"Hasan''s own boiler note."}', now());
  `);
});

describe("search your chats", () => {
  it("finds words inside messages, one best message per chat", async () => {
    const hits = await search(P.amir, "boiler");
    expect(hits.map((h) => h.chat_id).sort()).toEqual([C.boiler, C.garden].sort());
    expect(new Set(hits.map((h) => h.chat_id)).size).toBe(hits.length);
  });

  it("ranks the message with all the words first", async () => {
    const hits = await search(P.amir, "boiler quote");
    expect(hits[0]).toMatchObject({ chat_id: C.boiler, message_id: M.q1 });
    expect(hits[0].text).toBe("The boiler quote from Smith & Sons was £450 for the combi.");
  });

  it("finds stemmed words, numbers and codes", async () => {
    expect((await search(P.amir, "quotes")).map((h) => h.message_id)).toEqual([M.q1]);
    expect((await search(P.amir, "£450")).map((h) => h.message_id)).toEqual([M.q1]);
    expect((await search(P.amir, "B-12/77")).map((h) => h.message_id)).toEqual([M.q2]);
    expect((await search(P.amir, "tools")).map((h) => h.chat_id)).toEqual([C.garden]);
  });

  it("leaves out archived chats, system rows, and empty, one-letter or huge queries", async () => {
    expect((await search(P.amir, "archived")).map((h) => h.chat_id)).not.toContain(C.old);
    expect(await search(P.amir, "zebra")).toEqual([]);
    expect(await search(P.amir, "  ")).toEqual([]);
    expect(await search(P.amir, "b")).toEqual([]);
    expect(await search(P.amir, "boiler ".repeat(40))).toEqual([]);
  });

  it("shows the family admin only their own chats, even with titles shared", async () => {
    expect((await search(P.hasan, "boiler")).map((h) => h.chat_id)).toEqual([C.hasan]);
    expect(await search(P.hasan, "tools")).toEqual([]);
  });

  it("shows nothing to another family's admin", async () => {
    expect(await search(P.bea, "boiler")).toEqual([]);
  });

  it("can't be called by someone signed out", async () => {
    await expect(search(null, "boiler")).rejects.toThrow(/permission denied/);
  });

  it("finds nothing as the service role, which has no person to search for", async () => {
    const hits = await db.transaction(async (tx) => {
      await tx.exec("set local role service_role");
      return (await tx.query(`select * from public.search_my_chats('boiler')`)).rows;
    });
    expect(hits).toEqual([]);
  });
});
