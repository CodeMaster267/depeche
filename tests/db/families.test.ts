import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDatabase, rows } from "./harness";

/**
 * Sign-in and family functions. The server calls these with the service role after checking
 * who is signed in, so the tests call them the same way. They also prove that nobody can call
 * them from the browser.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const U = {
  hasan: id(1),
  amir: id(2),
  bea: id(3),
  stranger: id(9),
};

let db: PGlite;

async function asServer<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return db.transaction(async (tx) => {
    await tx.exec("set local role service_role");
    return (await tx.query<T>(sql, params)).rows;
  });
}
const one = async <T = unknown>(sql: string, params: unknown[] = []) =>
  Object.values((await asServer<Record<string, T>>(sql, params))[0] ?? {})[0] as T;

const inFuture = "now() + interval '7 days'";

beforeEach(async () => {
  db = await freshDatabase();
  await db.exec(`
    insert into auth.users (id, email) values
      ('${U.hasan}', 'Hasan@Example.com'), ('${U.amir}', 'amir@example.com'),
      ('${U.bea}', 'bea@example.com'), ('${U.stranger}', 'stranger@example.com');
  `);
});

async function setUpHasan() {
  return one<string>("select bootstrap_owner($1, 'Hasan', 'Khan family')", [U.hasan]);
}

describe("setting up the owner", () => {
  it("creates the owner's family with Hasan as its admin and app owner", async () => {
    const fam = await setUpHasan();
    const [me] = await asServer<{ family_id: string; role: string; is_app_owner: boolean }>(
      "select family_id, role, is_app_owner from profiles where id = $1",
      [U.hasan],
    );
    expect(me).toEqual({ family_id: fam, role: "admin", is_app_owner: true });
  });

  it("only works once", async () => {
    await setUpHasan();
    await expect(one("select bootstrap_owner($1, 'Mallory', 'Takeover')", [U.stranger])).rejects.toThrow(
      /already has an owner/,
    );
  });
});

describe("families and invites", () => {
  it("an admin invites a member, who accepts with the link and joins that family", async () => {
    const fam = await setUpHasan();
    await one("select create_invite($1, $2, 'Amir@Example.com ', 'Amir', 'member', 'h1', " + inFuture + ")", [
      U.hasan,
      fam,
    ]);

    const [preview] = await asServer("select * from invite_preview('h1')");
    expect(preview).toEqual({
      family_name: "Khan family",
      email: "amir@example.com",
      display_name: "Amir",
      role: "member",
      state: "valid",
    });

    expect(await one("select accept_invite('h1', $1)", [U.amir])).toBe(fam);
    const [amir] = await asServer("select family_id, role, display_name from profiles where id = $1", [U.amir]);
    expect(amir).toEqual({ family_id: fam, role: "member", display_name: "Amir" });
    expect((await asServer("select state from invite_preview('h1')"))[0]).toEqual({ state: "used" });
  });

  it("an invite link cannot be used twice or by someone with a different email", async () => {
    const fam = await setUpHasan();
    await one(`select create_invite($1, $2, 'amir@example.com', 'Amir', 'member', 'h1', ${inFuture})`, [U.hasan, fam]);
    await expect(one("select accept_invite('h1', $1)", [U.stranger])).rejects.toThrow(/different email/);
    await one("select accept_invite('h1', $1)", [U.amir]);
    await expect(one("select accept_invite('h1', $1)", [U.amir])).rejects.toThrow(/already been used/);
  });

  it("an expired invite cannot be used", async () => {
    const fam = await setUpHasan();
    await one(
      "select create_invite($1, $2, 'amir@example.com', 'Amir', 'member', 'h1', now() - interval '1 minute')",
      [U.hasan, fam],
    );
    expect((await asServer("select state from invite_preview('h1')"))[0]).toEqual({ state: "expired" });
    await expect(one("select accept_invite('h1', $1)", [U.amir])).rejects.toThrow(/expired/);
  });

  it("after Google or an email link, the person's open invite is found by their email", async () => {
    const fam = await setUpHasan();
    expect(await one("select accept_pending_invite($1)", [U.amir])).toBeNull();
    await one(`select create_invite($1, $2, 'amir@example.com', 'Amir', 'member', 'h1', ${inFuture})`, [U.hasan, fam]);
    expect(await one("select accept_pending_invite($1)", [U.amir])).toBe(fam);
  });

  it("members cannot invite anyone", async () => {
    const fam = await setUpHasan();
    await one(`select create_invite($1, $2, 'amir@example.com', 'Amir', 'member', 'h1', ${inFuture})`, [U.hasan, fam]);
    await one("select accept_invite('h1', $1)", [U.amir]);
    await expect(
      one(`select create_invite($1, $2, 'x@example.com', 'X', 'member', 'h2', ${inFuture})`, [U.amir, fam]),
    ).rejects.toThrow(/Only this family's admin/);
  });

  it("someone who already has an account cannot be invited again", async () => {
    const fam = await setUpHasan();
    await expect(
      one(`select create_invite($1, $2, 'hasan@example.com', 'H', 'member', 'h1', ${inFuture})`, [U.hasan, fam]),
    ).rejects.toThrow(/already has a Depeche account/);
  });

  it("the owner creates a family and invites its one admin, then sees nothing inside it", async () => {
    await setUpHasan();
    const famB = await one<string>("select create_family($1, 'Friends')", [U.hasan]);
    await one(`select create_invite($1, $2, 'bea@example.com', 'Bea', 'admin', 'hb', ${inFuture})`, [U.hasan, famB]);
    await one("select accept_invite('hb', $1)", [U.bea]);

    // Bea, now admin of Friends, invites Amir there.
    await one(`select create_invite($1, $2, 'amir@example.com', 'Amir', 'member', 'ha', ${inFuture})`, [U.bea, famB]);
    await one("select accept_invite('ha', $1)", [U.amir]);

    // Hasan can see the family's name, and the admin invite he sent, but not its people.
    expect(await rows(db, U.hasan, "select name from families where id = $1", [famB])).toEqual([{ name: "Friends" }]);
    expect(await rows(db, U.hasan, "select id from profiles where family_id = $1", [famB])).toEqual([]);
    const invites = await rows<{ email: string }>(db, U.hasan, "select email from invites where family_id = $1", [famB]);
    expect(invites.map((i) => i.email)).toEqual(["bea@example.com"]);

    // The owner cannot invite members into someone else's family, or a second admin.
    await expect(
      one(`select create_invite($1, $2, 'x@example.com', 'X', 'member', 'hx', ${inFuture})`, [U.hasan, famB]),
    ).rejects.toThrow(/Only this family's admin/);
    await expect(
      one(`select create_invite($1, $2, 'x@example.com', 'X', 'admin', 'hy', ${inFuture})`, [U.hasan, famB]),
    ).rejects.toThrow(/already has an admin/);
  });

  it("only the owner can create families", async () => {
    await setUpHasan();
    await expect(one("select create_family($1, 'Mine')", [U.stranger])).rejects.toThrow(/Only the owner/);
  });

  it("a family can never have two admins", async () => {
    const fam = await setUpHasan();
    await expect(
      db.exec(`insert into profiles (id, family_id, role, display_name) values ('${U.bea}', '${fam}', 'admin', 'Bea')`),
    ).rejects.toThrow(/profiles_one_admin_per_family/);
  });

  it("an admin can cancel an unused invite", async () => {
    const fam = await setUpHasan();
    const inv = await one<string>(
      `select create_invite($1, $2, 'amir@example.com', 'Amir', 'member', 'h1', ${inFuture})`,
      [U.hasan, fam],
    );
    await expect(one("select revoke_invite($1, $2)", [U.stranger, inv])).rejects.toThrow(/cannot cancel/);
    await one("select revoke_invite($1, $2)", [U.hasan, inv]);
    expect(await asServer("select * from invite_preview('h1')")).toEqual([]);
  });
});

describe("caps, usernames and password resets", () => {
  async function familyWithAmir() {
    const fam = await setUpHasan();
    await one(`select create_invite($1, $2, 'amir@example.com', 'Amir', 'member', 'h1', ${inFuture})`, [U.hasan, fam]);
    await one("select accept_invite('h1', $1)", [U.amir]);
    return fam;
  }

  it("the admin sets a member's cap; the member cannot", async () => {
    await familyWithAmir();
    await one("select set_member_cap($1, $2, 25)", [U.hasan, U.amir]);
    expect(await one("select monthly_cap_usd from profiles where id = $1", [U.amir])).toBe("25.00");
    await expect(one("select set_member_cap($1, $2, 999)", [U.amir, U.amir])).rejects.toThrow(/Only this family's admin/);
  });

  it("only a person's own family admin may reset their password", async () => {
    await familyWithAmir();
    expect(await one("select is_admin_of($1, $2)", [U.hasan, U.amir])).toBe(true);
    expect(await one("select is_admin_of($1, $2)", [U.amir, U.hasan])).toBe(false);
    expect(await one("select is_admin_of($1, $2)", [U.stranger, U.amir])).toBe(false);
  });

  it("usernames are unique, lower-case, and find the person's email for sign-in", async () => {
    await familyWithAmir();
    await one("select set_username($1, 'Amir.K')", [U.amir]);
    expect(await one("select email_for_username(' AMIR.k ')")).toBe("amir@example.com");
    await expect(one("select set_username($1, 'amir.k')", [U.hasan])).rejects.toThrow(/unique/);
    await expect(one("select set_username($1, 'no spaces')", [U.hasan])).rejects.toThrow(/check/);
    expect(await one("select email_for_username('nobody')")).toBeNull();
  });
});

describe("nobody can call these from the browser", () => {
  const calls = [
    "select app_owner_exists()",
    `select bootstrap_owner('${U.stranger}', 'Me', 'Mine')`,
    `select create_family('${U.hasan}', 'X')`,
    `select create_invite('${U.hasan}', '${U.hasan}', 'a@b.c', 'A', 'member', 'h', now())`,
    "select * from invite_preview('h')",
    `select accept_invite('h', '${U.stranger}')`,
    `select accept_pending_invite('${U.stranger}')`,
    `select revoke_invite('${U.hasan}', '${U.hasan}')`,
    `select set_member_cap('${U.hasan}', '${U.hasan}', 1000)`,
    `select set_username('${U.hasan}', 'x')`,
    "select email_for_username('x')",
    `select is_admin_of('${U.hasan}', '${U.amir}')`,
    `select email_of('${U.hasan}')`,
  ];
  for (const sql of calls) {
    it(sql.replace(/'[^']*'/g, "…"), async () => {
      await setUpHasan();
      for (const who of [null, U.hasan]) {
        await expect(rows(db, who, sql)).rejects.toThrow(/permission denied/);
      }
    });
  }
});
