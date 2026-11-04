import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDatabase, rows } from "./harness";

/**
 * Shared chats. Hasan is admin of family A with member Amir; Bea is in family B. Amir shares one of
 * his chats. Only the server writes shares; only Amir can see or delete his; anyone holding the link
 * can read that one share and nothing else.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2), bea: id(3) };
const F = { a: id(101), b: id(102) };
const C = { amir: id(201), amirOther: id(202), hasan: id(203) };
const TOKEN = "A".repeat(20) + "abcdefghij_-0123456789";
const SNAPSHOT = JSON.stringify([{ role: "user", text: "Hello" }, { role: "assistant", text: "Hi Amir" }]);

let db: PGlite;

async function asServer<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return db.transaction(async (tx) => {
    await tx.exec("set local role service_role");
    return (await tx.query<T>(sql, params)).rows;
  });
}

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
      ('${C.amir}', '${P.amir}', 'Trip'), ('${C.amirOther}', '${P.amir}', 'Other'), ('${C.hasan}', '${P.hasan}', 'Mine');
  `);
  await asServer(
    `insert into public.chat_shares (token, chat_id, owner_id, title, messages) values ($1, $2, $3, 'Trip', $4::jsonb)`,
    [TOKEN, C.amir, P.amir, SNAPSHOT],
  );
});

describe("chat shares", () => {
  it("can't be written from the browser, by the owner or anyone else", async () => {
    for (const who of [P.amir, P.hasan, null]) {
      await expect(
        as(db, who, (tx) =>
          tx.query(`insert into public.chat_shares (token, chat_id, owner_id, title, messages) values ($1, $2, $3, 'x', '[]')`, [
            "B".repeat(43),
            C.amirOther,
            P.amir,
          ]),
        ),
      ).rejects.toThrow(/permission denied/);
    }
    await expect(as(db, P.amir, (tx) => tx.query(`update public.chat_shares set title = 'Changed'`))).rejects.toThrow(/permission denied/);
  });

  it("can't be made by the server for someone else's chat", async () => {
    await expect(
      asServer(`insert into public.chat_shares (token, chat_id, owner_id, title, messages) values ($1, $2, $3, 'x', '[]')`, [
        "C".repeat(43),
        C.hasan,
        P.amir,
      ]),
    ).rejects.toThrow(/Only the chat's owner/);
  });

  it("are visible to their owner only: not to the family admin, another family or visitors", async () => {
    expect(await rows(db, P.amir, "select token, chat_id from chat_shares")).toEqual([{ token: TOKEN, chat_id: C.amir }]);
    expect(await rows(db, P.hasan, "select id from chat_shares")).toEqual([]);
    expect(await rows(db, P.bea, "select id from chat_shares")).toEqual([]);
    await expect(rows(db, null, "select id from chat_shares")).rejects.toThrow(/permission denied/);
  });

  it("never expose the copied messages through the table, even to the owner", async () => {
    await expect(rows(db, P.amir, "select messages from chat_shares")).rejects.toThrow(/permission denied/);
  });

  it("open for anyone holding the link, signed in or not", async () => {
    for (const who of [null, P.bea, P.hasan]) {
      const found = await rows<{ title: string; messages: unknown }>(db, who, "select title, messages from public.shared_chat($1)", [TOKEN]);
      expect(found).toEqual([{ title: "Trip", messages: JSON.parse(SNAPSHOT) }]);
    }
  });

  it("can't be found without the exact token", async () => {
    for (const guess of ["", "%", TOKEN.slice(0, -1), TOKEN.toLowerCase(), "' or 1=1 --"]) {
      expect(await rows(db, null, "select title from public.shared_chat($1)", [guess])).toEqual([]);
    }
  });

  it("can only be stopped by their owner, and the link then stops working", async () => {
    await as(db, P.hasan, (tx) => tx.query("delete from public.chat_shares"));
    await as(db, P.bea, (tx) => tx.query("delete from public.chat_shares"));
    expect(await rows(db, null, "select title from public.shared_chat($1)", [TOKEN])).toHaveLength(1);
    await as(db, P.amir, (tx) => tx.query("delete from public.chat_shares where chat_id = $1", [C.amir]));
    expect(await rows(db, null, "select title from public.shared_chat($1)", [TOKEN])).toEqual([]);
  });

  it("go when their chat is deleted", async () => {
    await asServer(`insert into public.chat_shares (token, chat_id, owner_id, title, messages) values ($1, $2, $3, 'Other', '[]')`, [
      "D".repeat(43),
      C.amirOther,
      P.amir,
    ]);
    await as(db, P.amir, (tx) => tx.query("delete from public.chats where id = $1", [C.amirOther]));
    expect(await asServer("select count(*)::int as n from chat_shares")).toEqual([{ n: 0 }]);
  });
});
