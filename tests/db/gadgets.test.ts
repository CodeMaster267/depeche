import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDatabase, rows } from "./harness";

/**
 * Gadgets: each person's saved gadgets, versions and saves are theirs alone; shares are seen by
 * the sender, the person they're for, or (on the family shelf) only that family; nobody signed in
 * can write any of it. And "No limit": only a family admin can turn it on, and with it the
 * spending check lets replies through past the monthly limit.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2), bea: id(3), cara: id(4) };
const F = { a: id(101), b: id(102) };
const G = { amir: id(201), cara: id(202) };

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
    insert into public.gadgets (id, owner_id, title, html) values
      ('${G.amir}', '${P.amir}', 'Chess', '<p>board</p>'),
      ('${G.cara}', '${P.cara}', 'Quiz', '<p>quiz</p>');
    insert into public.gadget_versions (gadget_id, owner_id, html) values ('${G.amir}', '${P.amir}', '<p>board</p>');
    insert into public.gadget_saves (gadget_id, owner_id, data) values ('${G.amir}', '${P.amir}', '{"moves":["e4"]}');
    insert into public.gadget_shares (family_id, from_id, to_id, title, html) values
      ('${F.a}', '${P.amir}', '${P.hasan}', 'Chess', '<p>board</p>'),
      ('${F.a}', '${P.amir}', null, 'Chess', '<p>board</p>'),
      ('${F.b}', '${P.cara}', null, 'Quiz', '<p>quiz</p>');
  `);
});

describe("gadgets", () => {
  it("each person sees only their own gadgets, versions and saves", async () => {
    expect(await rows(db, P.amir, "select title from gadgets")).toEqual([{ title: "Chess" }]);
    expect(await rows(db, P.amir, "select count(*)::int as n from gadget_versions")).toEqual([{ n: 1 }]);
    expect(await rows(db, P.amir, "select data from gadget_saves")).toEqual([{ data: '{"moves":["e4"]}' }]);
    // Not their admin, and not the app owner either.
    expect(await rows(db, P.hasan, "select * from gadgets")).toEqual([]);
    expect(await rows(db, P.hasan, "select * from gadget_saves")).toEqual([]);
    expect(await rows(db, P.bea, "select * from gadget_versions")).toEqual([]);
    await expect(rows(db, null, "select * from gadgets")).rejects.toThrow(/permission denied/);
  });

  it("shares are seen by the sender, the person they're for, and the family shelf by that family only", async () => {
    expect(await rows(db, P.hasan, "select to_id from gadget_shares order by to_id nulls last")).toEqual([{ to_id: P.hasan }, { to_id: null }]);
    expect((await rows(db, P.amir, "select * from gadget_shares")).length).toBe(2);
    // Another family sees only its own shelf.
    expect(await rows(db, P.bea, "select title from gadget_shares")).toEqual([{ title: "Quiz" }]);
  });

  it("can't be written from the browser, even your own", async () => {
    await expect(as(db, P.amir, (tx) => tx.query("insert into gadgets (owner_id, title, html) values ($1, 'x', 'y')", [P.amir]))).rejects.toThrow(/permission denied/);
    await expect(as(db, P.amir, (tx) => tx.query("update gadgets set html = 'z' where owner_id = $1", [P.amir]))).rejects.toThrow(/permission denied/);
    await expect(as(db, P.amir, (tx) => tx.query("delete from gadget_saves"))).rejects.toThrow(/permission denied/);
    await expect(
      as(db, P.amir, (tx) => tx.query("insert into gadget_shares (family_id, from_id, title, html) values ($1, $2, 'x', 'y')", [F.b, P.amir])),
    ).rejects.toThrow(/permission denied/);
  });

  it("are kept small", async () => {
    await expect(sr("insert into public.gadget_saves (gadget_id, owner_id, data) values ($1, $2, $3) on conflict (gadget_id) do update set data = excluded.data", [G.amir, P.amir, "x".repeat(100_001)])).rejects.toThrow(/check/);
    await expect(sr("insert into public.gadgets (owner_id, title, html) values ($1, $2, 'y')", [P.amir, "t".repeat(61)])).rejects.toThrow(/check/);
  });
});

describe("no limit", () => {
  it("can't be turned on by the person themselves", async () => {
    await expect(as(db, P.amir, (tx) => tx.query("update profiles set no_spend_limit = true where id = $1", [P.amir]))).rejects.toThrow(/permission denied/);
    await expect(as(db, P.amir, (tx) => tx.query("select public.set_member_no_limit($1, $1, true)", [P.amir]))).rejects.toThrow(/permission denied/);
  });

  it("only their family admin can turn it on", async () => {
    await expect(sr("select public.set_member_no_limit($1, $2, true)", [P.amir, P.amir])).rejects.toThrow(/Only this family's admin/);
    await expect(sr("select public.set_member_no_limit($1, $2, true)", [P.bea, P.amir])).rejects.toThrow(/Only this family's admin/);
    await sr("select public.set_member_no_limit($1, $2, true)", [P.hasan, P.amir]);
    expect(await sr("select no_spend_limit from public.profiles where id = $1", [P.amir])).toEqual([{ no_spend_limit: true }]);
    expect(await sr("select action from public.admin_log where subject_id = $1 order by created_at desc limit 1", [P.amir])).toEqual([{ action: "limit_removed" }]);
  });

  it("lets spending past the monthly limit only with no limit on", async () => {
    await sr("update public.profiles set monthly_cap_usd = 1 where id in ($1, $2)", [P.amir, P.cara]);
    await expect(sr("select * from public.reserve_spend($1, 5, 5)", [P.cara])).rejects.toThrow(/reached your \$1.00 limit/);
    const [hold] = await sr<{ amount_usd: string }>("select * from public.reserve_spend($1, 5, 5)", [P.amir]);
    expect(Number(hold.amount_usd)).toBe(5);
    await sr("select public.set_member_no_limit($1, $2, false)", [P.hasan, P.amir]);
    await expect(sr("select * from public.reserve_spend($1, 5, 5)", [P.amir])).rejects.toThrow(/limit/);
  });
});
