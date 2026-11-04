import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDatabase, rows } from "./harness";

/**
 * App lock: the PIN hash is readable by nobody signed in (a short PIN is easy to guess offline),
 * wrong guesses are counted by the database, and passkeys are visible only to their owner and
 * changed only by the server.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2), bea: id(4) };
const F = { a: id(101), b: id(102) };

let db: PGlite;

async function server<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return db.transaction(async (tx) => {
    await tx.exec("set local role service_role");
    return (await tx.query<T>(sql, params)).rows;
  });
}

beforeEach(async () => {
  db = await freshDatabase();
  await db.exec(`
    insert into auth.users (id, email) values
      ('${P.hasan}', 'hasan@example.com'), ('${P.amir}', 'amir@example.com'), ('${P.bea}', 'bea@example.com');
    insert into public.families (id, name, created_by) values ('${F.a}', 'Family A', '${P.hasan}'), ('${F.b}', 'B', '${P.hasan}');
    insert into public.profiles (id, family_id, role, is_app_owner, display_name, monthly_cap_usd) values
      ('${P.hasan}', '${F.a}', 'admin', true, 'Hasan', 50),
      ('${P.amir}', '${F.a}', 'member', false, 'Amir', 1),
      ('${P.bea}', '${F.b}', 'admin', false, 'Bea', 20);
  `);
  await server(
    `insert into public.app_locks (owner_id, pin_hash, pin_length) values ($1, 'scrypt$secret', 4), ($2, 'scrypt$other', 6)`,
    [P.amir, P.hasan],
  );
  await server(
    `insert into public.lock_passkeys (owner_id, credential_id, public_key, algorithm, label)
       values ($1, 'cred-amir-0123456789', '\\x0102', -7, 'iPhone'), ($2, 'cred-hasan-0123456789', '\\x0304', -7, 'Mac')`,
    [P.amir, P.hasan],
  );
});

describe("PIN", () => {
  it("nobody signed in can read the PIN hash, not even its owner or their admin", async () => {
    for (const who of [P.amir, P.hasan, P.bea, null]) {
      await expect(rows(db, who, "select pin_hash from public.app_locks")).rejects.toThrow(/permission denied/);
      await expect(rows(db, who, "select owner_id from public.app_locks")).rejects.toThrow(/permission denied/);
    }
  });

  it("nobody signed in can set, change or delete a PIN, or reset the wrong-try count", async () => {
    await expect(
      rows(db, P.amir, `insert into public.app_locks (owner_id, pin_hash, pin_length) values ($1, 'x', 4)`, [P.bea]),
    ).rejects.toThrow(/permission denied/);
    await expect(rows(db, P.amir, `update public.app_locks set failed_tries = 0`)).rejects.toThrow(/permission denied/);
    await expect(rows(db, P.amir, `delete from public.app_locks`)).rejects.toThrow(/permission denied/);
    await expect(rows(db, P.amir, `select * from public.lock_pin_attempt($1, true)`, [P.amir])).rejects.toThrow(/permission denied/);
  });

  it("wrong tries are counted, and from the fifth the wait doubles up to 15 minutes", async () => {
    const attempt = async (ok: boolean) =>
      (await server<{ failed_tries: number; wait_until: string | null }>(`select * from public.lock_pin_attempt($1, $2)`, [P.amir, ok]))[0];
    for (let i = 1; i <= 4; i++) expect(await attempt(false)).toMatchObject({ failed_tries: i, wait_until: null });
    const waitFor = async () => {
      const r = await attempt(false);
      return Math.round((new Date(r.wait_until!).getTime() - Date.now()) / 1000);
    };
    expect(await waitFor()).toBeCloseTo(30, -1);
    expect(await waitFor()).toBeCloseTo(60, -1);
    for (let i = 0; i < 10; i++) await attempt(false);
    expect(await waitFor()).toBeCloseTo(900, -1);
    // The right PIN clears the count.
    expect(await attempt(true)).toMatchObject({ failed_tries: 0, wait_until: null });
  });

  it("counts only the named person's tries", async () => {
    await server(`select * from public.lock_pin_attempt($1, false)`, [P.amir]);
    const all = await server<{ owner_id: string; failed_tries: number }>(`select owner_id, failed_tries from public.app_locks order by owner_id`);
    expect(all).toEqual([
      { owner_id: P.hasan, failed_tries: 0 },
      { owner_id: P.amir, failed_tries: 1 },
    ]);
  });
});

describe("passkeys", () => {
  it("people see only their own devices, and never the keys", async () => {
    expect(await rows(db, P.amir, "select label from public.lock_passkeys")).toEqual([{ label: "iPhone" }]);
    expect(await rows(db, P.hasan, "select label from public.lock_passkeys")).toEqual([{ label: "Mac" }]);
    expect(await rows(db, P.bea, "select label from public.lock_passkeys")).toEqual([]);
    expect(await rows(db, null, "select label from public.lock_passkeys").catch(() => [])).toEqual([]);
    await expect(rows(db, P.amir, "select public_key from public.lock_passkeys")).rejects.toThrow(/permission denied/);
    await expect(rows(db, P.amir, "select credential_id from public.lock_passkeys")).rejects.toThrow(/permission denied/);
  });

  it("only the server adds, changes or removes passkeys", async () => {
    await expect(
      rows(
        db,
        P.amir,
        `insert into public.lock_passkeys (owner_id, credential_id, public_key, algorithm, label) values ($1, 'cred-amir-9999999999', '\\x01', -7, 'x')`,
        [P.amir],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(rows(db, P.amir, `update public.lock_passkeys set label = 'y'`)).rejects.toThrow(/permission denied/);
    await expect(rows(db, P.amir, `delete from public.lock_passkeys`)).rejects.toThrow(/permission denied/);
  });

  it("a person's lock and passkeys go when their profile does", async () => {
    await db.exec(`delete from public.profiles where id = '${P.amir}'`);
    expect(await server(`select 1 from public.app_locks where owner_id = $1`, [P.amir])).toEqual([]);
    expect(await server(`select 1 from public.lock_passkeys where owner_id = $1`, [P.amir])).toEqual([]);
  });
});
