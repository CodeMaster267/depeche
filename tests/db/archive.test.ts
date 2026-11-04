import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDatabase, rows } from "./harness";

/**
 * The chat menu: rename, archive, restore and delete. Only the chat's owner can do any of them,
 * even a family admin who can see the member's chat titles.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2), sara: id(3) };
const F = id(101);
const C = { amir: id(201) };

let db: PGlite;

async function asServer<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return db.transaction(async (tx) => {
    await tx.exec("set local role service_role");
    return (await tx.query<T>(sql, params)).rows;
  });
}

const changed = async (person: string, sql: string) =>
  (await as(db, person, (tx) => tx.query(sql, [C.amir]))).affectedRows ?? 0;

beforeAll(async () => {
  db = await freshDatabase();
  await db.exec(`
    insert into auth.users (id, email) values
      ('${P.hasan}', 'h@example.com'), ('${P.amir}', 'a@example.com'), ('${P.sara}', 's@example.com');
    insert into public.families (id, name, created_by) values ('${F}', 'Family', '${P.hasan}');
    insert into public.profiles (id, family_id, role, is_app_owner, display_name, share_titles) values
      ('${P.hasan}', '${F}', 'admin', true, 'Hasan', false),
      ('${P.amir}', '${F}', 'member', false, 'Amir', true),
      ('${P.sara}', '${F}', 'member', false, 'Sara', false);
    insert into public.chats (id, owner_id, title) values ('${C.amir}', '${P.amir}', 'Chemistry revision');
  `);
});

describe("chat menu", () => {
  it("lets the owner archive and restore their chat", async () => {
    expect(await changed(P.amir, "update chats set archived_at = now() where id = $1")).toBe(1);
    expect(await rows(db, P.amir, "select archived_at is not null as archived from chats")).toEqual([{ archived: true }]);
    expect(await changed(P.amir, "update chats set archived_at = null where id = $1")).toBe(1);
    expect(await rows(db, P.amir, "select archived_at from chats")).toEqual([{ archived_at: null }]);
  });

  it("doesn't let a family admin who sees the title archive, rename or delete it", async () => {
    // Amir shares titles, so Hasan (his admin) can see the row, and still can't change it.
    expect(await rows(db, P.hasan, "select title from chats")).toEqual([{ title: "Chemistry revision" }]);
    expect(await changed(P.hasan, "update chats set archived_at = now() where id = $1")).toBe(0);
    expect(await changed(P.hasan, "update chats set title = 'mine now' where id = $1")).toBe(0);
    expect(await changed(P.hasan, "delete from chats where id = $1")).toBe(0);
  });

  it("doesn't let another member touch it", async () => {
    expect(await changed(P.sara, "update chats set archived_at = now() where id = $1")).toBe(0);
    expect(await changed(P.sara, "update chats set title = 'x' where id = $1")).toBe(0);
    expect(await changed(P.sara, "delete from chats where id = $1")).toBe(0);
    expect(await asServer("select title, archived_at from chats")).toEqual([{ title: "Chemistry revision", archived_at: null }]);
  });

  it("can't hand the chat to someone else", async () => {
    await expect(
      as(db, P.amir, (tx) => tx.query("update chats set owner_id = $2 where id = $1", [C.amir, P.sara])),
    ).rejects.toThrow(/permission denied/);
  });
});
