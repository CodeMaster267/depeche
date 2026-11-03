import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDatabase, rows } from "./harness";

/**
 * Hard spending caps, rate limits, the admin log, temporary passwords, backup admins and signing
 * people out. Two families: Hasan (owner) admins A with members Amir and Mina; Bea admins B with
 * member Ben. Every function that takes an actor is tried across families and must refuse.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2), mina: id(3), bea: id(4), ben: id(5), stranger: id(9) };
const F = { a: id(101), b: id(102) };

let db: PGlite;

async function server<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return db.transaction(async (tx) => {
    await tx.exec("set local role service_role");
    return (await tx.query<T>(sql, params)).rows;
  });
}
const one = async <T = unknown>(sql: string, params: unknown[] = []) =>
  Object.values((await server<Record<string, T>>(sql, params))[0] ?? {})[0] as T;

beforeEach(async () => {
  db = await freshDatabase();
  await db.exec(`
    insert into auth.users (id, email) values
      ('${P.hasan}', 'hasan@example.com'), ('${P.amir}', 'amir@example.com'), ('${P.mina}', 'mina@example.com'),
      ('${P.bea}', 'bea@example.com'), ('${P.ben}', 'ben@example.com'), ('${P.stranger}', 'x@example.com');
    insert into public.families (id, name, created_by) values
      ('${F.a}', 'Family A', '${P.hasan}'), ('${F.b}', 'Friends B', '${P.hasan}');
    insert into public.profiles (id, family_id, role, is_app_owner, display_name, monthly_cap_usd) values
      ('${P.hasan}', '${F.a}', 'admin',  true,  'Hasan', 50),
      ('${P.amir}',  '${F.a}', 'member', false, 'Amir',  1),
      ('${P.mina}',  '${F.a}', 'member', false, 'Mina',  1),
      ('${P.bea}',   '${F.b}', 'admin',  false, 'Bea',   20),
      ('${P.ben}',   '${F.b}', 'member', false, 'Ben',   1);
    insert into auth.sessions (user_id) values ('${P.amir}'), ('${P.amir}'), ('${P.ben}');
  `);
});

describe("hard spending caps", () => {
  it("reserves the worst case, and a reply is refused once holds and spending reach the cap", async () => {
    const [h] = await server<{ hold_id: string; amount_usd: string }>("select * from reserve_spend($1, 0.6, 0.01)", [P.amir]);
    expect(Number(h.amount_usd)).toBeCloseTo(0.6);
    // Only $0.40 is left while the first reply is still running, so the second gets at most that.
    const [h2] = await server<{ hold_id: string; amount_usd: string }>("select * from reserve_spend($1, 0.6, 0.01)", [P.amir]);
    expect(Number(h2.amount_usd)).toBeCloseTo(0.4);
    await expect(one("select reserve_spend($1, 0.6, 0.01)", [P.amir])).rejects.toThrow(/reached your \$1\.00 limit/);
    expect(Number(await one("select month_committed($1)", [P.amir]))).toBeCloseTo(1);
  });

  it("settling swaps the hold for the real cost and frees the rest", async () => {
    const [h] = await server<{ hold_id: string }>("select * from reserve_spend($1, 0.9, 0.01)", [P.amir]);
    await one("select settle_spend($1, null, 'google', 'gemini-3.8-flash', 1000, 2000, 0.05)", [h.hold_id]);
    expect(Number(await one("select month_spend($1)", [P.amir]))).toBeCloseTo(0.05);
    expect(Number(await one("select month_committed($1)", [P.amir]))).toBeCloseTo(0.05);
    await expect(one("select settle_spend($1, null, 'google', 'x', 1, 1, 0.01)", [h.hold_id])).rejects.toThrow(/No such hold/);
  });

  it("refuses when less than the cheapest useful reply is left", async () => {
    await server("select reserve_spend($1, 0.995, 0.001)", [P.amir]);
    await expect(one("select reserve_spend($1, 0.5, 0.01)", [P.amir])).rejects.toThrow(/limit/);
  });

  it("allows only a few replies at the same time, per person", async () => {
    for (let i = 0; i < 3; i++) await server("select reserve_spend($1, 0.01, 0.001)", [P.amir]);
    await expect(one("select reserve_spend($1, 0.01, 0.001)", [P.amir])).rejects.toThrow(/Too many replies/);
    // Someone else is unaffected.
    await server("select reserve_spend($1, 0.01, 0.001)", [P.mina]);
  });

  it("a hold left behind by a crash stops counting after ten minutes", async () => {
    await server("select reserve_spend($1, 1, 0.01)", [P.amir]);
    await db.exec("update spend_holds set expires_at = now() - interval '1 second'");
    await server("select reserve_spend($1, 1, 0.01)", [P.amir]);
  });

  it("nobody can read or write holds from the browser", async () => {
    await expect(rows(db, P.amir, "select * from spend_holds")).rejects.toThrow(/permission denied/);
    await expect(
      rows(db, P.amir, `insert into spend_holds (owner_id, amount_usd) values ('${P.amir}', -5)`),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("rate limits", () => {
  it("allows up to the limit in a window, then refuses", async () => {
    for (let i = 0; i < 3; i++) expect(await one("select rate_limit_hit('t:1', 3, 60)")).toBe(true);
    expect(await one("select rate_limit_hit('t:1', 3, 60)")).toBe(false);
    expect(await one("select rate_limit_hit('t:2', 3, 60)")).toBe(true);
    expect(await one("select rate_limit_used('t:1', 60)")).toBe(4);
    expect(await one("select rate_limit_used('t:9', 60)")).toBe(0);
  });
});

describe("backup admin", () => {
  it("an admin makes a member the backup admin; a third admin is refused", async () => {
    await one("select set_admin($1, $2, true)", [P.hasan, P.amir]);
    expect(await one("select role from profiles where id = $1", [P.amir])).toBe("admin");
    await expect(one("select set_admin($1, $2, true)", [P.hasan, P.mina])).rejects.toThrow(/already has a backup admin/);
  });

  it("the backup admin can step in: reset the other admin's password or sign them out", async () => {
    await one("select set_admin($1, $2, true)", [P.hasan, P.amir]);
    await one("select start_password_reset($1, $2)", [P.amir, P.hasan]);
    expect(await one("select must_change_password from profiles where id = $1", [P.hasan])).toBe(true);
  });

  it("a family always keeps an admin, and the owner stays admin of their own family", async () => {
    await expect(one("select set_admin($1, $2, false)", [P.bea, P.bea])).rejects.toThrow(/at least one admin/);
    await one("select set_admin($1, $2, true)", [P.hasan, P.amir]);
    await expect(one("select set_admin($1, $2, false)", [P.amir, P.hasan])).rejects.toThrow(/owner stays/);
    await one("select set_admin($1, $2, false)", [P.amir, P.amir]);
    expect(await one("select role from profiles where id = $1", [P.amir])).toBe("member");
  });

  it("members and other families cannot change admins", async () => {
    await expect(one("select set_admin($1, $2, true)", [P.amir, P.amir])).rejects.toThrow(/Only this family's admin/);
    await expect(one("select set_admin($1, $2, true)", [P.bea, P.amir])).rejects.toThrow(/Only this family's admin/);
    await expect(one("select set_admin($1, $2, true)", [P.hasan, P.ben])).rejects.toThrow(/Only this family's admin/);
  });
});

describe("signing out and temporary passwords", () => {
  const sessions = async (who: string) =>
    Number((await db.query<{ n: number }>("select count(*)::int as n from auth.sessions where user_id = $1", [who])).rows[0].n);

  it("anyone can sign themselves out everywhere", async () => {
    await one("select sign_out_everywhere($1, $1)", [P.amir]);
    expect(await sessions(P.amir)).toBe(0);
    expect(await sessions(P.ben)).toBe(1);
  });

  it("an admin can sign out a member of their family, but no one else", async () => {
    await expect(one("select sign_out_everywhere($1, $2)", [P.mina, P.amir])).rejects.toThrow(/Only this family's admin/);
    await expect(one("select sign_out_everywhere($1, $2)", [P.bea, P.amir])).rejects.toThrow(/Only this family's admin/);
    await expect(one("select sign_out_everywhere($1, $2)", [P.hasan, P.ben])).rejects.toThrow(/Only this family's admin/);
    expect(await sessions(P.amir)).toBe(2);
    await one("select sign_out_everywhere($1, $2)", [P.hasan, P.amir]);
    expect(await sessions(P.amir)).toBe(0);
  });

  it("a password reset signs the member out and makes them choose a new password", async () => {
    await one("select start_password_reset($1, $2)", [P.hasan, P.amir]);
    expect(await sessions(P.amir)).toBe(0);
    const [p] = await server<{ must_change_password: boolean; ok: boolean }>(
      "select must_change_password, temp_password_until between now() + interval '23 hours' and now() + interval '25 hours' as ok from profiles where id = $1",
      [P.amir],
    );
    expect(p).toEqual({ must_change_password: true, ok: true });
    await one("select password_changed($1)", [P.amir]);
    expect(await one("select must_change_password from profiles where id = $1", [P.amir])).toBe(false);
  });

  it("only the member's own family admin can reset their password, and not their own this way", async () => {
    for (const [actor, member] of [
      [P.mina, P.amir],
      [P.bea, P.amir],
      [P.hasan, P.ben],
      [P.hasan, P.hasan],
      [P.stranger, P.amir],
    ]) {
      await expect(one("select start_password_reset($1, $2)", [actor, member])).rejects.toThrow(/Only this family's admin/);
    }
  });

  it("members cannot clear their own must-change flag from the browser", async () => {
    await one("select start_password_reset($1, $2)", [P.hasan, P.amir]);
    await expect(
      rows(db, P.amir, "update profiles set must_change_password = false where id = $1", [P.amir]),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("invites", () => {
  it("last at most 7 days", async () => {
    await expect(
      one("select create_invite($1, $2, 'new@example.com', 'New', 'member', 'h1', now() + interval '14 days')", [P.hasan, F.a]),
    ).rejects.toThrow(/at most 7 days/);
    await one("select create_invite($1, $2, 'new@example.com', 'New', 'member', 'h1', now() + interval '7 days')", [P.hasan, F.a]);
  });

  it("can be cancelled by their family's admin only", async () => {
    const inv = await one<string>(
      "select create_invite($1, $2, 'new@example.com', 'New', 'member', 'h1', now() + interval '7 days')",
      [P.hasan, F.a],
    );
    await expect(one("select revoke_invite($1, $2)", [P.bea, inv])).rejects.toThrow(/cannot cancel/);
    await expect(one("select revoke_invite($1, $2)", [P.amir, inv])).rejects.toThrow(/cannot cancel/);
    await one("select revoke_invite($1, $2)", [P.hasan, inv]);
  });
});

describe("admin log", () => {
  async function someActions() {
    await one("select set_member_cap($1, $2, 5)", [P.hasan, P.amir]);
    await one("select set_member_cap($1, $2, 7)", [P.hasan, P.mina]);
    await one("select start_password_reset($1, $2)", [P.hasan, P.mina]);
    await one("select create_invite($1, $2, 'new@example.com', 'New', 'member', 'h1', now() + interval '7 days')", [P.hasan, F.a]);
    await one("select set_member_cap($1, $2, 3)", [P.bea, P.ben]);
    await one("select save_provider_key($1, 'google', '\\x00', 'abcd')", [P.bea]);
  }

  it("records each admin action, and the family's admin sees all of their family's", async () => {
    await someActions();
    const log = await rows<{ action: string }>(db, P.hasan, "select action from admin_log order by created_at, action");
    expect(log.map((l) => l.action).sort()).toEqual(["cap_changed", "cap_changed", "invite_created", "password_reset"]);
    const bea = await rows<{ action: string }>(db, P.bea, "select action from admin_log");
    expect(bea.map((l) => l.action).sort()).toEqual(["cap_changed", "key_saved"]);
  });

  it("a member sees only the entries about themselves", async () => {
    await someActions();
    const amir = await rows<{ action: string; detail: unknown }>(db, P.amir, "select action, detail from admin_log");
    expect(amir).toEqual([{ action: "cap_changed", detail: { from: 1, to: 5 } }]);
    expect(await rows(db, P.ben, "select action from admin_log")).toEqual([{ action: "cap_changed" }]);
  });

  it("cannot be written, changed or deleted from the browser", async () => {
    await someActions();
    await expect(
      rows(db, P.hasan, `insert into admin_log (family_id, action) values ('${F.a}', 'cap_changed')`),
    ).rejects.toThrow(/permission denied/);
    await expect(rows(db, P.hasan, "delete from admin_log")).rejects.toThrow(/permission denied/);
    await expect(rows(db, P.hasan, "update admin_log set action = 'key_saved'")).rejects.toThrow(/permission denied/);
  });
});

describe("across families, every server function refuses", () => {
  it("caps, keys and invites", async () => {
    await expect(one("select set_member_cap($1, $2, 99)", [P.hasan, P.ben])).rejects.toThrow(/Only this family's admin/);
    await expect(one("select set_member_cap($1, $2, 99)", [P.bea, P.amir])).rejects.toThrow(/Only this family's admin/);
    await expect(
      one("select create_invite($1, $2, 'n@example.com', 'N', 'member', 'hx', now() + interval '1 day')", [P.hasan, F.b]),
    ).rejects.toThrow(/Only this family's admin/);
    await expect(
      one("select create_invite($1, $2, 'n@example.com', 'N', 'member', 'hx', now() + interval '1 day')", [P.bea, F.a]),
    ).rejects.toThrow(/Only this family's admin/);
    // Keys always go to the actor's own family, whatever is asked.
    await one("select save_provider_key($1, 'google', '\\x01', 'zzzz')", [P.bea]);
    expect(await server("select family_id from provider_keys")).toEqual([{ family_id: F.b }]);
    await one("select remove_provider_key($1, 'google')", [P.hasan]);
    expect(await server("select family_id from provider_keys")).toEqual([{ family_id: F.b }]);
  });
});

describe("nobody can call the new functions from the browser", () => {
  const calls = [
    `select reserve_spend('${P.amir}', 1, 0)`,
    `select settle_spend('${P.amir}', null, 'x', 'y', 1, 1, 0)`,
    `select month_committed('${P.amir}')`,
    "select rate_limit_hit('k', 1, 60)",
    "select rate_limit_used('k', 60)",
    `select log_admin('${F.a}', '${P.hasan}', null, 'cap_changed', '{}')`,
    `select set_admin('${P.hasan}', '${P.amir}', true)`,
    `select sign_out_everywhere('${P.hasan}', '${P.amir}')`,
    `select start_password_reset('${P.hasan}', '${P.amir}')`,
    `select password_changed('${P.amir}')`,
    `select save_provider_key('${P.hasan}', 'google', '\\x00', 'abcd')`,
    `select remove_provider_key('${P.hasan}', 'google')`,
  ];
  for (const sql of calls) {
    it(sql.replace(/'[^']*'/g, "…"), async () => {
      for (const who of [null, P.hasan, P.amir]) {
        await expect(rows(db, who, sql)).rejects.toThrow(/permission denied/);
      }
    });
  }
});
