import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDatabase, rows } from "./harness";

/**
 * Demo keys sign someone into the app owner's account once. Only the server can read, add or burn
 * them; only the owner can add one; and each works exactly once, even when tried twice at once.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2) };
const F = { a: id(101) };
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

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
    insert into auth.users (id, email) values ('${P.hasan}', 'h@example.com'), ('${P.amir}', 'a@example.com');
    insert into public.families (id, name, created_by) values ('${F.a}', 'A', '${P.hasan}');
    insert into public.profiles (id, family_id, role, is_app_owner, display_name) values
      ('${P.hasan}', '${F.a}', 'admin', true, 'Hasan'),
      ('${P.amir}', '${F.a}', 'member', false, 'Amir');
  `);
});

describe("demo keys", () => {
  it("can be added only by the app owner", async () => {
    await expect(sr("select add_demo_key($1, $2)", [P.amir, H1])).rejects.toThrow(/Only the app owner/);
    expect(await sr("select add_demo_key($1, $2) is not null as ok", [P.hasan, H1])).toEqual([{ ok: true }]);
    await expect(sr("select add_demo_key($1, $2)", [P.hasan, H1])).rejects.toThrow(/already added/);
  });

  it("are out of reach of every signed-in person and of visitors", async () => {
    for (const who of [P.hasan, P.amir, null]) {
      await expect(rows(db, who, "select key_hash from public.demo_keys")).rejects.toThrow(/permission denied/);
      await expect(rows(db, who, "insert into public.demo_keys (key_hash, added_by) values ($1, $2)", [H2, P.hasan])).rejects.toThrow(
        /permission denied/,
      );
      await expect(rows(db, who, "update public.demo_keys set used_at = null")).rejects.toThrow(/permission denied/);
      await expect(rows(db, who, "select use_demo_key($1)", [H1])).rejects.toThrow(/permission denied/);
      await expect(rows(db, who, "select add_demo_key($1, $2)", [P.hasan, H2])).rejects.toThrow(/permission denied/);
    }
  });

  it("work exactly once", async () => {
    expect(await sr("select use_demo_key($1) as ok", [H2])).toEqual([{ ok: false }]);
    expect(await sr("select use_demo_key($1) as ok", [H1])).toEqual([{ ok: true }]);
    expect(await sr("select use_demo_key($1) as ok", [H1])).toEqual([{ ok: false }]);
    const [row] = await sr<{ used: boolean }>("select used_at is not null as used from demo_keys where key_hash = $1", [H1]);
    expect(row.used).toBe(true);
  });

  it("can't be re-added once used", async () => {
    await expect(sr("select add_demo_key($1, $2)", [P.hasan, H1])).rejects.toThrow(/already added/);
  });
});
