import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDatabase, rows } from "./harness";

/**
 * Answer-ready notifications. Hasan owns the app and is admin of family A, where Amir is a member.
 * Each person's notification devices and "away" marks are theirs alone: admins (and the owner)
 * can't see them, and only the server can add a device, so the browser can never point the
 * server's pushes at an address of its choosing.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2) };
const F = id(101);
const S = { amir: id(201), hasan: id(202) };
const R = { a: id(301), b: id(302) };

let db: PGlite;

async function asServer<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return db.transaction(async (tx) => {
    await tx.exec("set local role service_role");
    return (await tx.query<T>(sql, params)).rows;
  });
}

const attempt = (who: string | null, sql: string, params: unknown[] = []) =>
  as(db, who, (tx) => tx.query(sql, params)).then(
    () => "ok",
    (e: Error) => e.message,
  );

beforeAll(async () => {
  db = await freshDatabase();
  await db.exec(`
    insert into auth.users (id, email) values ('${P.hasan}', 'h@example.com'), ('${P.amir}', 'a@example.com');
    insert into public.families (id, name, created_by) values ('${F}', 'Family', '${P.hasan}');
    insert into public.profiles (id, family_id, role, is_app_owner, display_name, share_titles) values
      ('${P.hasan}', '${F}', 'admin', true, 'Hasan', false), ('${P.amir}', '${F}', 'member', false, 'Amir', true);
  `);
  await asServer(
    `insert into public.push_subscriptions (id, owner_id, endpoint, p256dh, auth, device) values
      ($1, $2, 'https://web.push.apple.com/amir', 'k1', 'a1', 'iPhone · Safari'),
      ($3, $4, 'https://fcm.googleapis.com/fcm/send/hasan', 'k2', 'a2', 'Mac · Chrome')`,
    [S.amir, P.amir, S.hasan, P.hasan],
  );
});

describe("notification devices", () => {
  it("each person sees only their own devices, and never the address or keys", async () => {
    expect(await rows(db, P.amir, "select id, device from push_subscriptions")).toEqual([{ id: S.amir, device: "iPhone · Safari" }]);
    expect(await rows(db, P.hasan, "select id from push_subscriptions")).toEqual([{ id: S.hasan }]);
    expect(await rows(db, null, "select id from push_subscriptions").catch(() => [])).toEqual([]);
    expect(await attempt(P.amir, "select endpoint from push_subscriptions")).toMatch(/permission denied/);
    expect(await attempt(P.amir, "select p256dh, auth from push_subscriptions")).toMatch(/permission denied/);
  });

  it("the browser can't add or change a device; only the server can", async () => {
    expect(
      await attempt(P.amir, "insert into push_subscriptions (owner_id, endpoint, p256dh, auth) values ($1, 'https://evil.example/x', 'k', 'a')", [P.amir]),
    ).toMatch(/permission denied/);
    expect(await attempt(P.amir, "update push_subscriptions set device = 'x'")).toMatch(/permission denied/);
  });

  it("a person can remove their own device but not someone else's", async () => {
    await as(db, P.hasan, (tx) => tx.query("delete from push_subscriptions where id = $1", [S.amir]));
    expect(await asServer("select id from push_subscriptions order by id")).toEqual([{ id: S.amir }, { id: S.hasan }]);
    await as(db, P.hasan, (tx) => tx.query("delete from push_subscriptions where id = $1", [S.hasan]));
    expect(await asServer("select id from push_subscriptions")).toEqual([{ id: S.amir }]);
  });
});

describe("away marks", () => {
  it("a person marks only their own answers, and nobody else sees the marks", async () => {
    await as(db, P.amir, (tx) => tx.query("insert into push_away (owner_id, request_id) values ($1, $2)", [P.amir, R.a]));
    expect(await attempt(P.amir, "insert into push_away (owner_id, request_id) values ($1, $2)", [P.hasan, R.b])).toMatch(/row-level security/);
    expect(await rows(db, P.amir, "select request_id from push_away")).toEqual([{ request_id: R.a }]);
    expect(await rows(db, P.hasan, "select request_id from push_away")).toEqual([]);
    await as(db, P.hasan, (tx) => tx.query("delete from push_away"));
    expect(await asServer("select request_id from push_away")).toEqual([{ request_id: R.a }]);
  });

  it("old marks are cleared by the server's daily clean-up, which the browser can't run", async () => {
    await asServer("insert into push_away (owner_id, request_id, created_at) values ($1, $2, now() - interval '2 days')", [P.amir, R.b]);
    expect(await attempt(P.amir, "select public.expire_push_away()")).toMatch(/permission denied/);
    expect(await asServer("select public.expire_push_away() as n")).toEqual([{ n: 1 }]);
    expect(await asServer("select request_id from push_away")).toEqual([{ request_id: R.a }]);
  });
});
