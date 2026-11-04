import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDatabase, rows } from "./harness";

/**
 * Personal designs: each person's designs are theirs alone; builds (the activity log) are seen by
 * the person, whoever ran them and their family admin; nobody signed in can write any of it; and
 * the build allowance holds, with failed builds not counted.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2), bea: id(3), cara: id(4) };
const F = { a: id(101), b: id(102) };

let db: PGlite;
const sr = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
  await db.exec("set role service_role");
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec("reset role");
  }
};

beforeAll(async () => {
  db = await freshDatabase();
  await db.exec(`
    insert into auth.users (id, email) values ('${P.hasan}', 'h@example.com'), ('${P.amir}', 'a@example.com'), ('${P.bea}', 'b@example.com'), ('${P.cara}', 'c@example.com');
    insert into public.families (id, name, created_by) values ('${F.a}', 'A', '${P.hasan}'), ('${F.b}', 'B', '${P.hasan}');
    insert into public.profiles (id, family_id, role, is_app_owner, display_name) values
      ('${P.hasan}', '${F.a}', 'admin', true, 'Hasan'),
      ('${P.amir}', '${F.a}', 'member', false, 'Amir'),
      ('${P.bea}', '${F.b}', 'admin', false, 'Bea'),
      ('${P.cara}', '${F.b}', 'member', false, 'Cara');
    insert into public.designs (id, owner_id, name, spec, status) values
      ('${id(201)}', '${P.amir}', 'Beach', '{"v":1}', 'kept'),
      ('${id(202)}', '${P.cara}', 'Forest', '{"v":1}', 'kept');
    insert into public.design_current (owner_id, design_id) values ('${P.amir}', '${id(201)}'), ('${P.cara}', '${id(202)}');
    insert into public.design_builds (family_id, owner_id, requested_by, brief, status) values
      ('${F.a}', '${P.amir}', '${P.amir}', 'make it a beach', 'built'),
      ('${F.b}', '${P.cara}', '${P.cara}', 'make it a forest', 'built');
  `);
});

describe("designs", () => {
  it("each person sees only their own designs", async () => {
    expect(await rows(db, P.amir, "select name from designs")).toEqual([{ name: "Beach" }]);
    expect(await rows(db, P.amir, "select design_id from design_current")).toEqual([{ design_id: id(201) }]);
    // Not their admin, and not the app owner.
    expect(await rows(db, P.hasan, "select * from designs")).toEqual([]);
    expect(await rows(db, P.hasan, "select * from design_current")).toEqual([]);
    expect(await rows(db, P.bea, "select * from designs where owner_id = $1", [P.amir])).toEqual([]);
  });

  it("are hidden from signed-out visitors", async () => {
    await expect(rows(db, null, "select * from designs")).rejects.toThrow(/permission denied/);
    await expect(rows(db, null, "select * from design_builds")).rejects.toThrow(/permission denied/);
  });

  it("can't be written from the browser, even your own", async () => {
    await expect(
      as(db, P.amir, (tx) => tx.query("insert into designs (owner_id, name, spec, status) values ($1, 'x', '{}', 'kept')", [P.amir])),
    ).rejects.toThrow(/permission denied/);
    await expect(as(db, P.amir, (tx) => tx.query("update designs set name = 'y' where owner_id = $1", [P.amir]))).rejects.toThrow(/permission denied/);
    await expect(as(db, P.amir, (tx) => tx.query("delete from design_current where owner_id = $1", [P.amir]))).rejects.toThrow(/permission denied/);
    await expect(
      as(db, P.amir, (tx) => tx.query("insert into design_builds (family_id, owner_id, requested_by, brief) values ($1, $2, $2, 'x')", [F.a, P.amir])),
    ).rejects.toThrow(/permission denied/);
    await expect(as(db, P.hasan, (tx) => tx.query("update design_settings set enabled = false"))).rejects.toThrow(/permission denied/);
    await expect(
      as(db, P.amir, (tx) => tx.query("insert into design_allowances (person_id, builds_per_month) values ($1, 500)", [P.amir])),
    ).rejects.toThrow(/permission denied/);
  });

  it("the server functions can't be called from the browser", async () => {
    await expect(as(db, P.amir, (tx) => tx.query("select public.start_design_build($1, $1, 'x')", [P.amir]))).rejects.toThrow(/permission denied/);
    await expect(as(db, P.hasan, (tx) => tx.query("select public.set_design_allowance($1, $2, 500)", [P.hasan, P.amir]))).rejects.toThrow(/permission denied/);
    await expect(as(db, P.hasan, (tx) => tx.query("select public.set_design_settings($1, true, 500)", [P.hasan]))).rejects.toThrow(/permission denied/);
  });
});

describe("design builds", () => {
  it("the family admin sees their family's builds, nobody else's", async () => {
    expect(await rows(db, P.hasan, "select brief from design_builds")).toEqual([{ brief: "make it a beach" }]);
    expect(await rows(db, P.bea, "select brief from design_builds")).toEqual([{ brief: "make it a forest" }]);
    expect(await rows(db, P.amir, "select brief from design_builds")).toEqual([{ brief: "make it a beach" }]);
    expect(await rows(db, P.cara, "select brief from design_builds where family_id = $1", [F.a])).toEqual([]);
  });

  it("are counted against the allowance, and failed ones aren't", async () => {
    await sr("select public.set_design_settings($1, true, 2)", [P.bea]);
    // Cara already has one built this month.
    const [first] = await sr<{ b: string }>("select public.start_design_build($1, $1, 'second') as b", [P.cara]);
    expect(first.b).toMatch(/^[0-9a-f-]{36}$/);
    await expect(sr("select public.start_design_build($1, $1, 'third')", [P.cara])).rejects.toThrow(/used all 2/);
    // The second one failed: it no longer counts, so there's room again.
    await sr("update design_builds set status = 'failed' where id = $1", [first.b]);
    expect((await sr<{ n: number }>("select public.design_builds_used($1) as n", [P.cara]))[0].n).toBe(1);
    await sr("select public.start_design_build($1, $1, 'third')", [P.cara]);
  });

  it("a person's own allowance beats the family's", async () => {
    await sr("select public.set_design_allowance($1, $2, 0)", [P.hasan, P.amir]);
    await expect(sr("select public.start_design_build($1, $1, 'x')", [P.amir])).rejects.toThrow(/used all 0/);
    await sr("select public.set_design_allowance($1, $2, null)", [P.hasan, P.amir]);
    expect((await sr<{ n: number }>("select public.design_allowance($1) as n", [P.amir]))[0].n).toBe(10);
  });

  it("only their family admin can set allowances or design for someone", async () => {
    await expect(sr("select public.set_design_allowance($1, $2, 50)", [P.bea, P.amir])).rejects.toThrow(/Only this family/);
    await expect(sr("select public.set_design_allowance($1, $2, 50)", [P.amir, P.amir])).rejects.toThrow(/Only this family/);
    await expect(sr("select public.set_design_settings($1, true, 50)", [P.amir])).rejects.toThrow(/Only a family admin/);
    await expect(sr("select public.start_design_build($1, $2, 'x')", [P.amir, P.hasan])).rejects.toThrow(/Only their family admin/);
    await expect(sr("select public.start_design_build($1, $2, 'x')", [P.bea, P.amir])).rejects.toThrow(/Only their family admin/);
    // The admin's build for a member counts against the admin.
    await sr("select public.start_design_build($1, $2, 'for amir')", [P.hasan, P.amir]);
    expect(await rows(db, P.amir, "select brief from design_builds where requested_by = $1", [P.hasan])).toEqual([{ brief: "for amir" }]);
  });

  it("the kill switch stops builds", async () => {
    await sr("select public.set_design_settings($1, false, 10)", [P.hasan]);
    await expect(sr("select public.start_design_build($1, $1, 'x')", [P.amir])).rejects.toThrow(/turned off/);
    expect(await rows(db, P.amir, "select enabled from design_settings")).toEqual([{ enabled: false }]);
    await sr("select public.set_design_settings($1, true, 10)", [P.hasan]);
  });

  it("allowances are visible to the person and their admin only", async () => {
    await sr("select public.set_design_allowance($1, $2, 4)", [P.hasan, P.amir]);
    expect(await rows(db, P.amir, "select builds_per_month from design_allowances")).toEqual([{ builds_per_month: 4 }]);
    expect(await rows(db, P.hasan, "select builds_per_month from design_allowances")).toEqual([{ builds_per_month: 4 }]);
    expect(await rows(db, P.bea, "select * from design_allowances")).toEqual([]);
    expect(await rows(db, P.cara, "select * from design_allowances")).toEqual([]);
  });

  it("everything goes when the person is deleted", async () => {
    await db.exec(`delete from public.profiles where id = '${P.cara}'`);
    expect((await db.query("select * from designs where owner_id = $1", [P.cara])).rows).toEqual([]);
    expect((await db.query("select * from design_current where owner_id = $1", [P.cara])).rows).toEqual([]);
  });
});
