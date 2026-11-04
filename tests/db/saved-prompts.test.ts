import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDatabase, rows } from "./harness";

/**
 * Saved prompts are private to their owner. Hasan is admin (and app owner) of family A with
 * member Amir; Bea is admin of family B. Nobody but the owner sees a prompt, not even its title.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2), bea: id(3) };
const F = { a: id(101), b: id(102) };

let db: PGlite;

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
  `);
});

const insert = (who: string, owner: string, title: string) =>
  rows(db, who, "insert into saved_prompts (owner_id, title, body) values ($1, $2, 'Translate {{text}} into {{language}}') returning id", [owner, title]);

describe("saved prompts", () => {
  it("can be saved by their owner", async () => {
    await insert(P.amir, P.amir, "Translate");
    expect(await rows(db, P.amir, "select title from saved_prompts")).toEqual([{ title: "Translate" }]);
  });

  it("are invisible to the family admin, the app owner and other families", async () => {
    for (const who of [P.hasan, P.bea]) expect(await rows(db, who, "select * from saved_prompts")).toEqual([]);
    expect(await rows(db, null, "select * from saved_prompts").catch(() => [])).toEqual([]);
  });

  it("can't be saved for someone else", async () => {
    await expect(insert(P.hasan, P.amir, "Sneaky")).rejects.toThrow(/row-level security/);
  });

  it("can't be edited or deleted by anyone else", async () => {
    await as(db, P.hasan, (tx) => tx.query("update saved_prompts set title = 'Changed'"));
    await as(db, P.hasan, (tx) => tx.query("delete from saved_prompts"));
    expect(await rows(db, P.amir, "select title from saved_prompts")).toEqual([{ title: "Translate" }]);
  });

  it("can be edited and deleted by their owner, but never moved to another person", async () => {
    await as(db, P.amir, (tx) => tx.query("update saved_prompts set title = 'Translate this', body = 'Hi {{name}}'"));
    expect(await rows(db, P.amir, "select title, body from saved_prompts")).toEqual([{ title: "Translate this", body: "Hi {{name}}" }]);
    await expect(as(db, P.amir, (tx) => tx.query("update saved_prompts set owner_id = $1", [P.hasan]))).rejects.toThrow(/permission denied/);
    await as(db, P.amir, (tx) => tx.query("delete from saved_prompts"));
    expect(await rows(db, P.amir, "select * from saved_prompts")).toEqual([]);
  });

  it("need a title and text, within limits", async () => {
    await expect(insert(P.amir, P.amir, "")).rejects.toThrow(/check/);
    await expect(insert(P.amir, P.amir, "x".repeat(81))).rejects.toThrow(/check/);
    await expect(
      rows(db, P.amir, "insert into saved_prompts (owner_id, title, body) values ($1, 'Empty', '')", [P.amir]),
    ).rejects.toThrow(/check/);
  });

  it("stop at 200 each", async () => {
    await db.exec(`insert into saved_prompts (owner_id, title, body) select '${P.bea}', 'P' || n, 'text' from generate_series(1, 200) n`);
    await expect(insert(P.bea, P.bea, "One too many")).rejects.toThrow(/up to 200/);
    await insert(P.amir, P.amir, "Amir still can");
  });

  it("go when their owner's profile does", async () => {
    await db.exec(`delete from public.profiles where id = '${P.bea}'`);
    expect((await db.query("select count(*)::int as n from saved_prompts where owner_id = $1", [P.bea])).rows).toEqual([{ n: 0 }]);
  });
});
