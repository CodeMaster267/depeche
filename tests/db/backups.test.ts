import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDatabase } from "./harness";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const HASAN = id(1);
const FAMILY = id(101);

let db: PGlite;

beforeAll(async () => {
  db = await freshDatabase();
  await db.exec(`
    insert into auth.users (id, email) values ('${HASAN}', 'hasan@example.com');
    insert into public.families (id, name, created_by) values ('${FAMILY}', 'Family A', '${HASAN}');
    insert into public.profiles (id, family_id, role, is_app_owner, display_name)
      values ('${HASAN}', '${FAMILY}', 'admin', true, 'Hasan');
    insert into public.backup_runs (backup_name, started_at, size_bytes, tables, rows, restore_verified)
      values ('depeche-backup-2026-11-03', now(), 8321, 35, 5, true);
  `);
});

const insert = `insert into backup_runs (backup_name, started_at, size_bytes, tables, rows, restore_verified)
  values ('fake', now(), 1, 1, 1, true)`;

describe("backup records", () => {
  for (const [who, user] of [["visitors", null], ["the app owner", HASAN]] as const) {
    it(`cannot be read by ${who}`, async () => {
      await expect(as(db, user, (tx) => tx.query("select * from backup_runs"))).rejects.toThrow(/permission denied/);
    });
    it(`cannot be faked by ${who}`, async () => {
      await expect(as(db, user, (tx) => tx.query(insert))).rejects.toThrow(/permission denied/);
      await expect(as(db, user, (tx) => tx.query("delete from backup_runs"))).rejects.toThrow(/permission denied/);
    });
  }

  it("are written by the backup job", async () => {
    await db.exec(insert);
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from backup_runs");
    expect(rows[0].n).toBe(2);
  });
});
