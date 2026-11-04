import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDatabase, rows } from "./harness";

/**
 * Chats about to be auto-deleted: each person sees only their own, and keeping one restarts its
 * month. Nobody else can keep (or see) someone's expiring chats.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2), sara: id(3) };
const F = id(101);
const C = { soon: id(201), later: id(202), pinned: id(203), fresh: id(204), saraSoon: id(205), archived: id(206) };

let db: PGlite;

async function asServer<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return db.transaction(async (tx) => {
    await tx.exec("set local role service_role");
    return (await tx.query<T>(sql, params)).rows;
  });
}

beforeAll(async () => {
  db = await freshDatabase();
  await db.exec(`
    insert into auth.users (id, email) values
      ('${P.hasan}', 'h@example.com'), ('${P.amir}', 'a@example.com'), ('${P.sara}', 's@example.com');
    insert into public.families (id, name, created_by) values ('${F}', 'Family', '${P.hasan}');
    insert into public.profiles (id, family_id, role, is_app_owner, display_name, share_titles) values
      ('${P.hasan}', '${F}', 'admin', true, 'Hasan', false),
      ('${P.amir}', '${F}', 'member', false, 'Amir', true),
      ('${P.sara}', '${F}', 'member', false, 'Sara', false);
    insert into public.chats (id, owner_id, title, pinned, updated_at, archived_at) values
      ('${C.soon}', '${P.amir}', 'Due tomorrow', false, now() - interval '29 days', null),
      ('${C.archived}', '${P.amir}', 'Archived and due', false, now() - interval '28 days', now() - interval '20 days'),
      ('${C.later}', '${P.amir}', 'Due in a week', false, now() - interval '23 days', null),
      ('${C.pinned}', '${P.amir}', 'Pinned', true, now() - interval '60 days', null),
      ('${C.fresh}', '${P.amir}', 'Fresh', false, now(), null),
      ('${C.saraSoon}', '${P.sara}', 'Sara due', false, now() - interval '29 days', null);
  `);
});

const expiring = (person: string) =>
  rows<{ title: string; archived: boolean }>(db, person, "select title, archived from public.my_expiring_chats(3)");

describe("chats about to be deleted", () => {
  it("lists only your own chats due within three days, soonest first, archived ones included", async () => {
    expect(await expiring(P.amir)).toEqual([
      { title: "Due tomorrow", archived: false },
      { title: "Archived and due", archived: true },
    ]);
    expect(await expiring(P.sara)).toEqual([{ title: "Sara due", archived: false }]);
    // Hasan is Amir's admin and can see his titles, but never his expiring list.
    expect(await expiring(P.hasan)).toEqual([]);
  });

  it("keeping a chat restarts its month without moving it in the list", async () => {
    const before = await asServer<{ updated_at: string }>("select updated_at from chats where id = $1", [C.soon]);
    await as(db, P.amir, (tx) => tx.query("update chats set kept_at = now() where id = $1", [C.soon]));
    expect(await expiring(P.amir)).toEqual([{ title: "Archived and due", archived: true }]);
    expect(await asServer("select updated_at from chats where id = $1", [C.soon])).toEqual(before);
  });

  it("doesn't let anyone else keep your chat", async () => {
    for (const other of [P.hasan, P.sara]) {
      const r = await as(db, other, (tx) => tx.query("update chats set kept_at = now() where id = $1", [C.archived]));
      expect(r.affectedRows ?? 0).toBe(0);
    }
    expect(await asServer("select kept_at from chats where id = $1", [C.archived])).toEqual([{ kept_at: null }]);
  });

  it("the clean-up spares kept chats and deletes the rest that are due", async () => {
    await asServer("update chats set updated_at = now() - interval '31 days' where id in ($1, $2, $3)", [C.soon, C.archived, C.saraSoon]);
    expect(await asServer("select public.expire_old_chats() as n")).toEqual([{ n: 2 }]);
    const left = await asServer<{ title: string }>("select title from chats order by title");
    expect(left.map((r) => r.title)).toEqual(["Due in a week", "Due tomorrow", "Fresh", "Pinned"]);
  });

  it("is empty for someone who keeps all their chats", async () => {
    await as(db, P.amir, (tx) => tx.query("update profiles set keep_chats = true where id = $1", [P.amir]));
    await asServer("update chats set updated_at = now() - interval '29 days', kept_at = null where id = $1", [C.later]);
    expect(await expiring(P.amir)).toEqual([]);
  });
});
