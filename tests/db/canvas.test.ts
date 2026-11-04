import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDatabase, rows } from "./harness";

/**
 * Canvas: a document beside the chat. Hasan owns the app and is admin of family A, where Amir is
 * a member who shares chat titles with his admin. Bea is admin of family B. Only Amir may ever
 * see or change Amir's canvases; only the server may write the AI's versions.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2), bea: id(3) };
const F = { a: id(101), b: id(102) };
const C = { amir: id(201), hasan: id(202) };
const M = { q: id(301), a: id(302) };
const K = { amir: id(401), hasan: id(402) };
const V = { first: id(501) };

let db: PGlite;

async function asServer<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return db.transaction(async (tx) => {
    await tx.exec("set local role service_role");
    return (await tx.query<T>(sql, params)).rows;
  });
}

const tryAs = (who: string | null, sql: string, params: unknown[] = []) =>
  as(db, who, (tx) => tx.query(sql, params)).then(
    () => "ok",
    (e: Error) => e.message,
  );

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
    insert into public.chats (id, owner_id, title, updated_at) values
      ('${C.amir}', '${P.amir}', 'Speech', now() - interval '20 days'), ('${C.hasan}', '${P.hasan}', 'Code', now());
    insert into public.messages (id, chat_id, owner_id, parent_id, role, content) values
      ('${M.q}', '${C.amir}', '${P.amir}', null, 'user', '{"text":"Write my speech in the canvas"}'),
      ('${M.a}', '${C.amir}', '${P.amir}', '${M.q}', 'assistant', '{"text":"Here it is."}');
  `);
  // The server saves the AI's canvas from its reply.
  await asServer(
    `insert into public.canvases (id, chat_id, owner_id, title) values ($1, $2, $3, 'Wedding-speech'), ($4, $5, $6, 'app.py')`,
    [K.amir, C.amir, P.amir, K.hasan, C.hasan, P.hasan],
  );
  await asServer(
    `insert into public.canvas_versions (id, canvas_id, owner_id, content, author, message_id, created_at)
     values ($1, $2, $3, '# A toast', 'assistant', $4, now() - interval '1 minute'), (default, $5, $6, 'print(1)', 'assistant', null, now())`,
    [V.first, K.amir, P.amir, M.a, K.hasan, P.hasan],
  );
});

describe("canvas privacy", () => {
  it("shows a person their own canvases and versions", async () => {
    expect(await rows(db, P.amir, "select title from public.canvases")).toEqual([{ title: "Wedding-speech" }]);
    expect(await rows(db, P.amir, "select content, author from public.canvas_versions")).toEqual([{ content: "# A toast", author: "assistant" }]);
  });

  it("shows the family admin and app owner nothing, not even the title", async () => {
    expect(await rows(db, P.hasan, `select * from public.canvases where owner_id = '${P.amir}'`)).toEqual([]);
    expect(await rows(db, P.hasan, `select * from public.canvas_versions where owner_id = '${P.amir}'`)).toEqual([]);
    // He can still see the chat's title, which Amir shares; the canvas stays private.
    expect(await rows(db, P.hasan, `select title from public.chats where id = '${C.amir}'`)).toEqual([{ title: "Speech" }]);
  });

  it("shows another family nothing, and visitors nothing", async () => {
    expect(await rows(db, P.bea, "select * from public.canvases")).toEqual([]);
    expect(await rows(db, P.bea, "select * from public.canvas_versions")).toEqual([]);
    expect(await tryAs(null, "select * from public.canvases")).toMatch(/permission denied/);
    expect(await tryAs(null, "select * from public.canvas_versions")).toMatch(/permission denied/);
  });
});

describe("canvas edits", () => {
  it("lets a person save their own edit as a new version, and marks the chat as used", async () => {
    await as(db, P.amir, (tx) =>
      tx.query("insert into public.canvas_versions (canvas_id, owner_id, content, author) values ($1, $2, $3, 'person')", [K.amir, P.amir, "# A toast\n\nMy edit."]),
    );
    const versions = await rows<{ content: string; author: string }>(db, P.amir, "select content, author from public.canvas_versions order by created_at");
    expect(versions.map((v) => v.author)).toEqual(["assistant", "person"]);
    const [chat] = await rows<{ fresh: boolean }>(db, P.amir, `select updated_at > now() - interval '1 minute' as fresh from public.chats where id = '${C.amir}'`);
    expect(chat.fresh).toBe(true);
  });

  it("never lets the browser write the AI's versions or tie a version to a reply", async () => {
    expect(
      await tryAs(P.amir, "insert into public.canvas_versions (canvas_id, owner_id, content, author) values ($1, $2, 'x', 'assistant')", [K.amir, P.amir]),
    ).toMatch(/row-level security/);
    expect(
      await tryAs(P.amir, "insert into public.canvas_versions (canvas_id, owner_id, content, author, message_id) values ($1, $2, 'x', 'person', $3)", [K.amir, P.amir, M.a]),
    ).toMatch(/row-level security/);
  });

  it("never lets anyone write into someone else's canvas, even their admin", async () => {
    expect(
      await tryAs(P.hasan, "insert into public.canvas_versions (canvas_id, owner_id, content, author) values ($1, $2, 'x', 'person')", [K.amir, P.hasan]),
    ).toMatch(/row-level security/);
    expect(
      await tryAs(P.hasan, "insert into public.canvas_versions (canvas_id, owner_id, content, author) values ($1, $2, 'x', 'person')", [K.amir, P.amir]),
    ).toMatch(/row-level security/);
    expect(
      await tryAs(P.bea, "insert into public.canvas_versions (canvas_id, owner_id, content, author) values ($1, $2, 'x', 'person')", [K.amir, P.bea]),
    ).toMatch(/row-level security/);
  });

  it("keeps versions append-only: no changing or removing them, and no making canvases from the browser", async () => {
    expect(await tryAs(P.amir, `update public.canvas_versions set content = 'gone' where id = '${V.first}'`)).toMatch(/permission denied/);
    expect(await tryAs(P.amir, `delete from public.canvas_versions where id = '${V.first}'`)).toMatch(/permission denied/);
    expect(await tryAs(P.amir, `update public.canvases set title = 'x' where id = '${K.amir}'`)).toMatch(/permission denied/);
    expect(await tryAs(P.amir, `delete from public.canvases where id = '${K.amir}'`)).toMatch(/permission denied/);
    expect(
      await tryAs(P.amir, "insert into public.canvases (chat_id, owner_id, title) values ($1, $2, 'Mine')", [C.amir, P.amir]),
    ).toMatch(/permission denied/);
    expect(await tryAs(P.amir, "select public.canvas_version_touch()")).toMatch(/permission denied/);
  });

  it("caps a version's size", async () => {
    expect(
      await tryAs(P.amir, "insert into public.canvas_versions (canvas_id, owner_id, content, author) values ($1, $2, repeat('a', 200001), 'person')", [K.amir, P.amir]),
    ).toMatch(/check constraint/);
  });

  it("keeps one canvas per title in a chat", async () => {
    await expect(asServer(`insert into public.canvases (chat_id, owner_id, title) values ($1, $2, 'wedding-SPEECH')`, [C.amir, P.amir])).rejects.toThrow(/unique/);
  });

  it("goes when its chat is deleted", async () => {
    await as(db, P.hasan, (tx) => tx.query(`delete from public.chats where id = '${C.hasan}'`));
    expect(await asServer(`select * from public.canvases where id = '${K.hasan}'`)).toEqual([]);
    expect(await asServer(`select * from public.canvas_versions where canvas_id = '${K.hasan}'`)).toEqual([]);
  });
});
