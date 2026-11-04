import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDatabase, rows } from "./harness";

/**
 * Deep research runs: the plan, notes and spending of a research report while it is being written.
 * Hasan owns the app and is admin of family A, where Amir is a member who shares chat titles with
 * his admin. Bea is admin of family B. Only Amir may see Amir's research, and only the server may
 * write it.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2), bea: id(3) };
const F = { a: id(101), b: id(102) };
const C = { amir: id(201), hasan: id(202) };
const M = { q: id(301), hq: id(302) };
const R = { amir: id(401) };

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
      ('${P.hasan}', 'hasan@example.com'), ('${P.amir}', 'amir@example.com'), ('${P.bea}', 'bea@example.com');
    insert into public.families (id, name, created_by) values
      ('${F.a}', 'Family A', '${P.hasan}'), ('${F.b}', 'Friends B', '${P.hasan}');
    insert into public.profiles (id, family_id, role, is_app_owner, display_name, share_titles) values
      ('${P.hasan}', '${F.a}', 'admin', true, 'Hasan', false),
      ('${P.amir}', '${F.a}', 'member', false, 'Amir', true),
      ('${P.bea}', '${F.b}', 'admin', false, 'Bea', false);
    insert into public.chats (id, owner_id, title) values
      ('${C.amir}', '${P.amir}', 'Heat pumps'), ('${C.hasan}', '${P.hasan}', 'Mine');
    insert into public.messages (id, chat_id, owner_id, role, content) values
      ('${M.q}', '${C.amir}', '${P.amir}', 'user', '{"text":"Research heat pumps for an old house"}'),
      ('${M.hq}', '${C.hasan}', '${P.hasan}', 'user', '{"text":"Mine"}');
  `);
  await asServer(
    `insert into public.research_runs (id, owner_id, chat_id, question_id, model, questions, notes)
     values ($1, $2, $3, $4, 'claude-sonnet-5-5', '["Do they work in old houses?"]', '[{"question":"q","text":"secret notes"}]')`,
    [R.amir, P.amir, C.amir, M.q],
  );
});

describe("deep research runs", () => {
  it("the person sees their own runs", async () => {
    const mine = await rows<{ id: string; notes: unknown }>(db, P.amir, "select id, notes from public.research_runs");
    expect(mine.map((r) => r.id)).toEqual([R.amir]);
  });

  it("nobody else sees them: not the family admin, the app owner, another family or a visitor", async () => {
    for (const who of [P.hasan, P.bea, null]) {
      const seen = await rows(db, who, "select id from public.research_runs").catch(() => []);
      expect(seen).toEqual([]);
    }
  });

  it("the browser can't start, change or delete a run, even its own", async () => {
    await expect(
      rows(db, P.amir, `insert into public.research_runs (owner_id, chat_id, question_id, model) values ($1, $2, $3, 'x')`, [
        P.amir,
        C.amir,
        M.q,
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(rows(db, P.amir, "update public.research_runs set cost_usd = 0, status = 'done'")).rejects.toThrow(/permission denied/);
    await expect(rows(db, P.amir, "delete from public.research_runs")).rejects.toThrow(/permission denied/);
    await expect(rows(db, null, "select id from public.research_runs")).rejects.toThrow(/permission denied/);
  });

  it("only one step can claim a run at a time", async () => {
    const claim = () =>
      asServer(
        `update public.research_runs set lease_until = now() + interval '5 minutes'
         where id = $1 and status = 'running' and (lease_until is null or lease_until < now()) returning id`,
        [R.amir],
      );
    expect(await claim()).toHaveLength(1);
    expect(await claim()).toHaveLength(0);
  });

  it("goes when its chat is deleted", async () => {
    await asServer("delete from public.chats where id = $1", [C.amir]);
    expect(await asServer("select id from public.research_runs")).toEqual([]);
  });
});
