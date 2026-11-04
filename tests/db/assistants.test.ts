import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDatabase, rows } from "./harness";

/**
 * Saved assistants: private to their maker until shared, then visible to the maker's own family
 * only. Only the maker can change one, and sharing never reaches another family.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2), sara: id(3), omar: id(4) };
const F = { khan: id(101), other: id(102) };
const A = { helper: id(301), secret: id(302) };

let db: PGlite;

async function asServer<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return db.transaction(async (tx) => {
    await tx.exec("set local role service_role");
    return (await tx.query<T>(sql, params)).rows;
  });
}

const run = async (person: string | null, sql: string, params: unknown[] = []) =>
  (await as(db, person, (tx) => tx.query(sql, params))).affectedRows ?? 0;

beforeAll(async () => {
  db = await freshDatabase();
  await db.exec(`
    insert into auth.users (id, email) values
      ('${P.hasan}', 'h@example.com'), ('${P.amir}', 'a@example.com'), ('${P.sara}', 's@example.com'), ('${P.omar}', 'o@example.com');
    insert into public.families (id, name, created_by) values ('${F.khan}', 'Khan', '${P.hasan}'), ('${F.other}', 'Other', '${P.hasan}');
    insert into public.profiles (id, family_id, role, is_app_owner, display_name) values
      ('${P.hasan}', '${F.khan}', 'admin', true, 'Hasan'),
      ('${P.amir}', '${F.khan}', 'member', false, 'Amir'),
      ('${P.sara}', '${F.khan}', 'member', false, 'Sara'),
      ('${P.omar}', '${F.other}', 'admin', false, 'Omar');
  `);
});

describe("saved assistants", () => {
  it("are made by a person for themselves, in their own family whatever the browser says", async () => {
    expect(
      await run(P.amir, "insert into assistants (id, owner_id, family_id, name, instructions) values ($1, $2, $3, 'Homework helper', 'Guide, never give answers')", [
        A.helper,
        P.amir,
        F.other,
      ]),
    ).toBe(1);
    expect(await run(P.amir, "insert into assistants (id, owner_id, name) values ($1, $2, 'Diary')", [A.secret, P.amir])).toBe(1);
    expect(await asServer("select family_id from assistants where id = $1", [A.helper])).toEqual([{ family_id: F.khan }]);
    await expect(as(db, P.amir, (tx) => tx.query("insert into assistants (owner_id, name) values ($1, 'x')", [P.sara]))).rejects.toThrow(
      /row-level security/,
    );
  });

  it("stay private until shared, even from the family admin", async () => {
    expect(await rows(db, P.hasan, "select * from assistants")).toEqual([]);
    expect(await rows(db, P.sara, "select * from assistants")).toEqual([]);
    await expect(rows(db, null, "select * from assistants")).rejects.toThrow(/permission denied/);
  });

  it("once shared, are seen by the family and nobody outside it", async () => {
    expect(await run(P.amir, "update assistants set shared = true where id = $1", [A.helper])).toBe(1);
    expect(await rows(db, P.sara, "select name, instructions from assistants")).toEqual([
      { name: "Homework helper", instructions: "Guide, never give answers" },
    ]);
    expect(await rows(db, P.hasan, "select name from assistants")).toEqual([{ name: "Homework helper" }]);
    expect(await rows(db, P.omar, "select * from assistants")).toEqual([]);
  });

  it("can only be changed or deleted by their maker", async () => {
    expect(await run(P.sara, "update assistants set instructions = 'Give answers' where id = $1", [A.helper])).toBe(0);
    expect(await run(P.hasan, "update assistants set shared = false where id = $1", [A.helper])).toBe(0);
    expect(await run(P.hasan, "delete from assistants where id = $1", [A.helper])).toBe(0);
    await expect(as(db, P.amir, (tx) => tx.query("update assistants set family_id = $2 where id = $1", [A.helper, F.other]))).rejects.toThrow(
      /permission denied/,
    );
    await expect(as(db, P.amir, (tx) => tx.query("update assistants set owner_id = $2 where id = $1", [A.helper, P.sara]))).rejects.toThrow(
      /permission denied/,
    );
  });

  it("share their file list with the family, and only the maker adds files", async () => {
    expect(
      await run(P.amir, "insert into assistant_files (assistant_id, owner_id, path, name, mime, size) values ($1, $2, $3, 'rules.txt', 'text/plain', 10)", [
        A.helper,
        P.amir,
        `${P.amir}/f1/rules.txt`,
      ]),
    ).toBe(1);
    expect(
      await run(P.amir, "insert into assistant_files (assistant_id, owner_id, path, name, mime, size) values ($1, $2, $3, 'diary.txt', 'text/plain', 10)", [
        A.secret,
        P.amir,
        `${P.amir}/f2/diary.txt`,
      ]),
    ).toBe(1);
    expect(await rows(db, P.sara, "select name from assistant_files")).toEqual([{ name: "rules.txt" }]);
    expect(await rows(db, P.omar, "select * from assistant_files")).toEqual([]);
    await expect(
      as(db, P.sara, (tx) =>
        tx.query("insert into assistant_files (assistant_id, owner_id, path, name, mime, size) values ($1, $2, $3, 'x.txt', 'text/plain', 1)", [
          A.helper,
          P.sara,
          `${P.sara}/x/x.txt`,
        ]),
      ),
    ).rejects.toThrow(/foreign key/);
    expect(await run(P.sara, "delete from assistant_files")).toBe(0);
  });

  it("keep their files from the 3-day clean-up", async () => {
    await asServer(`insert into storage.objects (bucket_id, name, created_at) values
      ('uploads', '${P.amir}/f1/rules.txt', now() - interval '9 days'), ('uploads', '${P.amir}/f3/loose.txt', now() - interval '9 days')`);
    const due = await asServer<{ name: string }>("select public.expired_uploads() as name");
    expect(due.map((r) => r.name)).toEqual([`${P.amir}/f3/loose.txt`]);
  });

  it("can be chatted with, and the chat stays private to whoever is chatting", async () => {
    expect(await run(P.sara, "insert into chats (owner_id, title, assistant_id) values ($1, 'Maths', $2)", [P.sara, A.helper])).toBe(1);
    expect(await rows(db, P.amir, "select * from chats")).toEqual([]);
    // The assistant a chat started with can't be swapped afterwards.
    await expect(as(db, P.sara, (tx) => tx.query("update chats set assistant_id = null"))).rejects.toThrow(/permission denied/);
  });

  it("when deleted, leave the chats made with them", async () => {
    expect(await run(P.amir, "delete from assistants where id = $1", [A.helper])).toBe(1);
    expect(await asServer("select title, assistant_id from chats")).toEqual([{ title: "Maths", assistant_id: null }]);
    expect(await asServer("select name from assistant_files")).toEqual([{ name: "diary.txt" }]);
  });
});
