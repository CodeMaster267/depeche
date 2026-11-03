import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDatabase, rows } from "./harness";

/**
 * "Search this chat" (search_chat): the model's lookup of earlier wording in the chat it is
 * answering. Hasan owns the app and is admin of family A, where Amir is a member who shares chat
 * titles with his admin. Bea is admin of family B. Only Amir may ever find Amir's words.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2), bea: id(3) };
const F = { a: id(101), b: id(102) };
const C = { amir: id(201), amir2: id(202) };
const M = { q1: id(301), a1: id(302), q2: id(303), a2: id(304), other: id(305), branch: id(306), sys: id(307) };

let db: PGlite;

const search = (who: string | null, query: string, ids: string[] | null = null, chat = C.amir) =>
  rows<{ id: string; role: string; text: string }>(db, who, "select id, role, text from public.search_chat($1, $2, $3, 8)", [
    chat,
    query,
    ids,
  ]);

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
    insert into public.chats (id, owner_id, title) values
      ('${C.amir}', '${P.amir}', 'Boiler'), ('${C.amir2}', '${P.amir}', 'Other');
    insert into public.messages (id, chat_id, owner_id, parent_id, role, content, created_at) values
      ('${M.q1}', '${C.amir}', '${P.amir}', null, 'user', '{"text":"The boiler quote from Smith & Sons was £450 for the combi."}', now() - interval '5 min'),
      ('${M.a1}', '${C.amir}', '${P.amir}', '${M.q1}', 'assistant', '{"text":"That is a fair price for replacing boilers."}', now() - interval '4 min'),
      ('${M.q2}', '${C.amir}', '${P.amir}', '${M.a1}', 'user', '{"text":"My reference number is B-12/77."}', now() - interval '3 min'),
      ('${M.a2}', '${C.amir}', '${P.amir}', '${M.q2}', 'assistant', '{"text":"Noted."}', now() - interval '2 min'),
      ('${M.branch}', '${C.amir}', '${P.amir}', '${M.q1}', 'assistant', '{"text":"An older boiler answer on another branch."}', now() - interval '1 min'),
      ('${M.sys}', '${C.amir}', '${P.amir}', null, 'system', '{"text":"boiler system note"}', now()),
      ('${M.other}', '${C.amir2}', '${P.amir}', null, 'user', '{"text":"My boiler in the other chat."}', now());
  `);
});

describe("search this chat", () => {
  it("finds the owner's own words, word for word, with stemming", async () => {
    const hits = await search(P.amir, "boiler");
    expect(hits.map((h) => h.id).sort()).toEqual([M.q1, M.a1, M.branch].sort());
    expect(hits.find((h) => h.id === M.q1)?.text).toBe("The boiler quote from Smith & Sons was £450 for the combi.");
  });

  it("finds numbers and codes by plain substring", async () => {
    expect((await search(P.amir, "£450")).map((h) => h.id)).toEqual([M.q1]);
    expect((await search(P.amir, "B-12/77")).map((h) => h.id)).toEqual([M.q2]);
  });

  it("matches any of the words, best match first", async () => {
    const hits = await search(P.amir, "combi quote reference");
    expect(hits[0].id).toBe(M.q1);
    expect(hits.map((h) => h.id)).toContain(M.q2);
  });

  it("stays inside one chat and the messages it is given (the active path)", async () => {
    const hits = await search(P.amir, "boiler", [M.q1, M.a1, M.q2, M.a2]);
    expect(hits.map((h) => h.id).sort()).toEqual([M.q1, M.a1].sort());
    expect((await search(P.amir, "boiler", null, C.amir2)).map((h) => h.id)).toEqual([M.other]);
  });

  it("never returns system rows, and nothing for an empty or huge query", async () => {
    expect((await search(P.amir, "system note")).map((h) => h.id)).not.toContain(M.sys);
    expect(await search(P.amir, "   ")).toEqual([]);
    expect(await search(P.amir, "boiler ".repeat(100))).toEqual([]);
  });

  it("shows nothing to the family admin, even with chat titles shared", async () => {
    expect(await search(P.hasan, "boiler")).toEqual([]);
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
      return (await tx.query(`select * from public.search_chat($1, 'boiler')`, [C.amir])).rows;
    });
    expect(hits).toEqual([]);
  });
});
