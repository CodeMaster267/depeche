import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDatabase, rows } from "./harness";

/** Chats unused for a month are deleted, unless pinned or their owner chose to keep chats. */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2) };
const F = id(101);

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
    insert into auth.users (id, email) values ('${P.hasan}', 'h@example.com'), ('${P.amir}', 'a@example.com');
    insert into public.families (id, name, created_by) values ('${F}', 'Family', '${P.hasan}');
    insert into public.profiles (id, family_id, role, is_app_owner, display_name) values
      ('${P.hasan}', '${F}', 'admin', true, 'Hasan'), ('${P.amir}', '${F}', 'member', false, 'Amir');
    insert into public.chats (owner_id, title, pinned, updated_at) values
      ('${P.amir}', 'old', false, now() - interval '31 days'),
      ('${P.amir}', 'old but pinned', true, now() - interval '90 days'),
      ('${P.amir}', 'recent', false, now() - interval '29 days'),
      ('${P.hasan}', 'hasan old', false, now() - interval '60 days');
  `);
});

describe("chat expiry", () => {
  it("people can choose to keep their own chats, and nobody else's", async () => {
    await as(db, P.hasan, (tx) => tx.query("update profiles set keep_chats = true where id = $1", [P.hasan]));
    await as(db, P.hasan, (tx) => tx.query("update profiles set keep_chats = true where id = $1", [P.amir]));
    expect(await asServer("select id, keep_chats from profiles order by id")).toEqual([
      { id: P.hasan, keep_chats: true },
      { id: P.amir, keep_chats: false },
    ]);
  });

  it("deletes month-old chats, keeping pinned ones and those of people who keep chats", async () => {
    expect(await asServer("select public.expire_old_chats() as n")).toEqual([{ n: 1 }]);
    const left = await asServer<{ title: string }>("select title from chats order by title");
    expect(left.map((r) => r.title)).toEqual(["hasan old", "old but pinned", "recent"]);
  });

  it("can only be run by the server", async () => {
    await expect(rows(db, P.amir, "select public.expire_old_chats()")).rejects.toThrow(/permission denied/);
  });
});
