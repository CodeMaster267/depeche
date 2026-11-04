import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDatabase, rows } from "./harness";

/**
 * Personal instructions ("About me" and "How should Depeche answer") are as private as memories:
 * only the person can read or change their own. Their family admin and the app owner see nothing.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2), bea: id(3) };
const F = { a: id(101), b: id(102) };

let db: PGlite;

beforeAll(async () => {
  db = await freshDatabase();
  await db.exec(`
    insert into auth.users (id, email) values ('${P.hasan}', 'h@example.com'), ('${P.amir}', 'a@example.com'), ('${P.bea}', 'b@example.com');
    insert into public.families (id, name, created_by) values ('${F.a}', 'A', '${P.hasan}'), ('${F.b}', 'B', '${P.hasan}');
    insert into public.profiles (id, family_id, role, is_app_owner, display_name) values
      ('${P.hasan}', '${F.a}', 'admin', true, 'Hasan'),
      ('${P.amir}', '${F.a}', 'member', false, 'Amir'),
      ('${P.bea}', '${F.b}', 'admin', false, 'Bea');
    insert into public.personal_instructions (owner_id, about_me, answer_style) values
      ('${P.amir}', 'Amir is 15 and studies chemistry', 'Short answers please'),
      ('${P.bea}', 'Bea is a nurse', 'Be formal');
  `);
});

describe("personal instructions", () => {
  it("each person sees only their own", async () => {
    expect(await rows(db, P.amir, "select about_me from personal_instructions")).toEqual([{ about_me: "Amir is 15 and studies chemistry" }]);
    expect(await rows(db, P.bea, "select about_me from personal_instructions")).toEqual([{ about_me: "Bea is a nurse" }]);
  });

  it("are hidden from the family admin and the app owner", async () => {
    expect(await rows(db, P.hasan, "select * from personal_instructions")).toEqual([]);
    expect(await rows(db, P.hasan, "select * from personal_instructions where owner_id = $1", [P.amir])).toEqual([]);
  });

  it("are hidden from signed-out visitors", async () => {
    await expect(rows(db, null, "select * from personal_instructions")).rejects.toThrow(/permission denied/);
  });

  it("a person can write and change their own", async () => {
    await as(db, P.hasan, (tx) =>
      tx.query("insert into personal_instructions (owner_id, about_me, answer_style) values ($1, 'I build Depeche', 'Be brief')", [P.hasan]),
    );
    await as(db, P.hasan, (tx) => tx.query("update personal_instructions set answer_style = 'Be very brief', enabled = false where owner_id = $1", [P.hasan]));
    expect(await rows(db, P.hasan, "select answer_style, enabled from personal_instructions")).toEqual([{ answer_style: "Be very brief", enabled: false }]);
  });

  it("nobody can write or change someone else's", async () => {
    await expect(
      as(db, P.hasan, (tx) => tx.query("insert into personal_instructions (owner_id, about_me) values ($1, 'x')", [P.bea])),
    ).rejects.toThrow(/row-level security|duplicate key/);
    await as(db, P.hasan, (tx) => tx.query("update personal_instructions set about_me = 'hacked' where owner_id = $1", [P.amir]));
    await as(db, P.hasan, (tx) => tx.query("delete from personal_instructions where owner_id = $1", [P.amir]));
    expect(await rows(db, P.amir, "select about_me from personal_instructions")).toEqual([{ about_me: "Amir is 15 and studies chemistry" }]);
  });

  it("cannot be moved to another person", async () => {
    await expect(
      as(db, P.amir, (tx) => tx.query("update personal_instructions set owner_id = $1 where owner_id = $2", [P.bea, P.amir])),
    ).rejects.toThrow(/permission denied/);
  });

  it("are capped at 1,500 characters each", async () => {
    await expect(
      as(db, P.amir, (tx) => tx.query("update personal_instructions set about_me = repeat('a', 1501) where owner_id = $1", [P.amir])),
    ).rejects.toThrow(/check constraint/);
  });

  it("go when the person's profile is deleted", async () => {
    await db.exec(`delete from public.profiles where id = '${P.bea}'`);
    expect((await db.query("select * from personal_instructions where owner_id = $1", [P.bea])).rows).toEqual([]);
  });
});
