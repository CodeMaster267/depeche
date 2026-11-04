import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDatabase, rows } from "./harness";

/**
 * Chat summaries (auto-compaction). Hasan is admin and app owner of family A with member Amir; Bea
 * is admin of family B. Summaries are message contents: only their owner reads them, only the
 * server writes them, and the owner can only discard their own.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2), bea: id(3) };
const F = { a: id(101), b: id(102) };
const CHAT = id(201);
const M = { one: id(301), two: id(302) };
const S = id(401);

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
    insert into public.profiles (id, family_id, role, is_app_owner, display_name) values
      ('${P.hasan}', '${F.a}', 'admin', true, 'Hasan'),
      ('${P.amir}', '${F.a}', 'member', false, 'Amir'),
      ('${P.bea}', '${F.b}', 'admin', false, 'Bea');
    insert into public.chats (id, owner_id, title) values ('${CHAT}', '${P.amir}', 'Long chat');
    insert into public.messages (id, chat_id, owner_id, parent_id, role, content) values
      ('${M.one}', '${CHAT}', '${P.amir}', null, 'user', '{"text":"hi"}'),
      ('${M.two}', '${CHAT}', '${P.amir}', '${M.one}', 'assistant', '{"text":"hello"}');
  `);
  await asServer(
    `insert into chat_summaries (id, chat_id, owner_id, through_message_id, summary, facts, provider, model)
     values ($1, $2, $3, $4, 'They said hello.', '["Budget is £450"]', 'anthropic', 'claude-haiku-5-5')`,
    [S, CHAT, P.amir, M.two],
  );
});

describe("chat summaries", () => {
  it("are readable by their owner", async () => {
    expect(await rows(db, P.amir, "select summary, facts from chat_summaries")).toEqual([
      { summary: "They said hello.", facts: ["Budget is £450"] },
    ]);
  });

  it("are never readable by the family admin, the app owner, or another family", async () => {
    expect(await rows(db, P.hasan, "select id from chat_summaries")).toEqual([]);
    expect(await rows(db, P.bea, "select id from chat_summaries")).toEqual([]);
    expect(await rows(db, null, "select id from chat_summaries").catch(() => [])).toEqual([]);
  });

  it("cannot be written or changed from the browser, even by their owner", async () => {
    await expect(
      rows(
        db,
        P.amir,
        `insert into chat_summaries (chat_id, owner_id, through_message_id, summary, provider, model)
         values ($1, $2, $3, 'fake', 'anthropic', 'x')`,
        [CHAT, P.amir, M.one],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(rows(db, P.amir, "update chat_summaries set summary = 'changed'")).rejects.toThrow(/permission denied/);
    await expect(rows(db, P.amir, "delete from chat_summaries")).rejects.toThrow(/permission denied/);
  });

  it("are made once per point in a chat", async () => {
    await expect(
      asServer(
        `insert into chat_summaries (chat_id, owner_id, through_message_id, summary, provider, model)
         values ($1, $2, $3, 'again', 'anthropic', 'x')`,
        [CHAT, P.amir, M.two],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it("can be discarded by their owner only", async () => {
    await expect(rows(db, P.hasan, "select public.discard_chat_summary($1)", [S])).rejects.toThrow(/No such summary/);
    await expect(rows(db, null, "select public.discard_chat_summary($1)", [S])).rejects.toThrow(/permission denied/);
    expect(await asServer("select status from chat_summaries")).toEqual([{ status: "active" }]);
    await rows(db, P.amir, "select public.discard_chat_summary($1)", [S]);
    expect(await asServer("select status, summary from chat_summaries")).toEqual([{ status: "discarded", summary: "They said hello." }]);
    // A discarded summary can be redone at the same point.
    await asServer(
      `insert into chat_summaries (chat_id, owner_id, through_message_id, summary, provider, model)
       values ($1, $2, $3, 'Redone.', 'anthropic', 'x')`,
      [CHAT, P.amir, M.two],
    );
    expect(await rows(db, P.amir, "select status from chat_summaries order by created_at, status")).toHaveLength(2);
  });

  it("can be turned off per chat by its owner only", async () => {
    await as(db, P.hasan, (tx) => tx.query("update chats set compaction = 'off' where id = $1", [CHAT]));
    expect(await asServer("select compaction from chats")).toEqual([{ compaction: "auto" }]);
    await as(db, P.amir, (tx) => tx.query("update chats set compaction = 'off' where id = $1", [CHAT]));
    expect(await asServer("select compaction from chats")).toEqual([{ compaction: "off" }]);
    await expect(as(db, P.amir, (tx) => tx.query("update chats set compaction = 'sometimes'"))).rejects.toThrow(/check/);
  });

  it("go when their chat is deleted", async () => {
    await as(db, P.amir, (tx) => tx.query("delete from chats where id = $1", [CHAT]));
    expect(await asServer("select count(*)::int as n from chat_summaries")).toEqual([{ n: 0 }]);
  });
});
