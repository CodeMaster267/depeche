import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDatabase, rows } from "./harness";
import { activePath, latestLeaf, pathTo, versionsOf, type MessageRow } from "@/lib/chat/thread";

/**
 * Editing a message and regenerating a reply add new messages beside the old ones. Nothing is
 * changed or removed, and a new message can only follow one in the same chat of the same person.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2) };
const F = { a: id(101) };
const C = { hasan: id(201), hasan2: id(202), amir: id(203) };
const M = { q1: id(301), a1: id(302), other: id(303), amir: id(304) };

let db: PGlite;

const asServer = (sql: string, params: unknown[] = []) =>
  db.transaction(async (tx) => {
    await tx.exec("set local role service_role");
    return (await tx.query(sql, params)).rows;
  });

const insertAs = (who: string, chat: string, parent: string | null, text: string) =>
  as(db, who, (tx) =>
    tx.query<{ id: string }>(
      `insert into messages (chat_id, owner_id, parent_id, role, content) values ($1, $2, $3, 'user', $4) returning id`,
      [chat, who, parent, { text }],
    ),
  );

beforeAll(async () => {
  db = await freshDatabase();
  await db.exec(`
    insert into auth.users (id, email) values ('${P.hasan}', 'hasan@example.com'), ('${P.amir}', 'amir@example.com');
    insert into public.families (id, name, created_by) values ('${F.a}', 'Family A', '${P.hasan}');
    insert into public.profiles (id, family_id, role, is_app_owner, display_name) values
      ('${P.hasan}', '${F.a}', 'admin', true, 'Hasan'), ('${P.amir}', '${F.a}', 'member', false, 'Amir');
    insert into public.chats (id, owner_id, title) values
      ('${C.hasan}', '${P.hasan}', 'one'), ('${C.hasan2}', '${P.hasan}', 'two'), ('${C.amir}', '${P.amir}', 'amir');
  `);
  await asServer(
    `insert into messages (id, chat_id, owner_id, parent_id, role, content) values
      ($1, $5, $7, null, 'user', '{"text":"first"}'),
      ($2, $5, $7, $1, 'assistant', '{"text":"answer"}'),
      ($3, $6, $7, null, 'user', '{"text":"elsewhere"}'),
      ($4, $8, $9, null, 'user', '{"text":"amir"}')`,
    [M.q1, M.a1, M.other, M.amir, C.hasan, C.hasan2, P.hasan, C.amir, P.amir],
  );
});

describe("message versions", () => {
  it("an edit is a new message beside the original, which is kept", async () => {
    // Editing the first message: a new first message (no parent). Editing a later one: same parent.
    await insertAs(P.hasan, C.hasan, null, "first, edited");
    await insertAs(P.hasan, C.hasan, M.a1, "follow-up");
    await insertAs(P.hasan, C.hasan, M.a1, "follow-up, edited");
    const texts = await rows<{ t: string }>(db, P.hasan, `select content->>'text' as t from messages where chat_id = $1 order by created_at`, [C.hasan]);
    expect(texts.map((r) => r.t)).toEqual(["first", "answer", "first, edited", "follow-up", "follow-up, edited"]);
  });

  it("a new message can't follow one from another chat", async () => {
    await expect(insertAs(P.hasan, C.hasan, M.other, "x")).rejects.toThrow(/same chat/);
  });

  it("a new message can't follow someone else's message, even into their chat", async () => {
    await expect(insertAs(P.hasan, C.hasan, M.amir, "x")).rejects.toThrow(/same chat/);
    await expect(insertAs(P.hasan, C.amir, M.amir, "x")).rejects.toThrow();
  });

  it("the server can't make a reply follow a message in another chat either", async () => {
    await expect(
      asServer(`insert into messages (chat_id, owner_id, parent_id, role, content) values ($1, $2, $3, 'assistant', '{}')`, [C.hasan, P.hasan, M.other]),
    ).rejects.toThrow(/same chat/);
  });

  it("versions still can't be changed or deleted from the browser", async () => {
    await expect(as(db, P.hasan, (tx) => tx.query(`update messages set content = '{}' where id = $1`, [M.q1]))).rejects.toThrow();
    const gone = await as(db, P.hasan, (tx) => tx.query(`delete from messages where id = $1`, [M.q1]).catch(() => ({ affectedRows: 0 })));
    expect(gone.affectedRows ?? 0).toBe(0);
    expect(await rows(db, P.hasan, `select id from messages where id = $1`, [M.q1])).toHaveLength(1);
  });
});

describe("the conversation tree", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const m = (id: string, parent: string | null, role: MessageRow["role"], s: number): MessageRow => ({
    id, chat_id: "c", parent_id: parent, role, content: { text: id }, status: "completed", model: null, created_at: at(s),
  });
  // q → a (regenerated as a2) → q2; q edited as qe → ae.
  const tree = [m("q", null, "user", 1), m("a", "q", "assistant", 2), m("a2", "q", "assistant", 3), m("q2", "a2", "user", 4), m("r2", "q2", "assistant", 5), m("qe", null, "user", 6), m("ae", "qe", "assistant", 7)];

  it("shows the newest branch by default", () => {
    expect(activePath(tree).map((x) => x.id)).toEqual(["qe", "ae"]);
  });

  it("flips to an earlier version and carries on to where that version's conversation ended", () => {
    const leaf = latestLeaf(tree, "q");
    expect(leaf).toBe("r2");
    expect(pathTo(tree, leaf).map((x) => x.id)).toEqual(["q", "a2", "q2", "r2"]);
    expect(pathTo(tree, latestLeaf(tree, "a")).map((x) => x.id)).toEqual(["q", "a"]);
  });

  it("numbers versions oldest first", () => {
    expect(versionsOf(tree, tree[0]).map((x) => x.id)).toEqual(["q", "qe"]);
    expect(versionsOf(tree, tree[2]).map((x) => x.id)).toEqual(["a", "a2"]);
    expect(versionsOf(tree, tree[3]).map((x) => x.id)).toEqual(["q2"]);
  });
});
