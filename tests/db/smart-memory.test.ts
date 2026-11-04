import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDatabase, rows } from "./harness";

/**
 * Smart memory adds who a fact is about (`about`) and which newer memory replaced an older one
 * (`replaced_by`). Both stay as private as the memory itself, and a memory can only be replaced
 * by one of the same person's.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2), bea: id(3) };
const F = { a: id(101), b: id(102) };
const M = { amirDad: id(201), amirNew: id(202), beaOne: id(203) };

let db: PGlite;

beforeAll(async () => {
  db = await freshDatabase();
  await db.exec(`
    insert into auth.users (id, email) values ('${P.hasan}', 'h@example.com'), ('${P.amir}', 'a@example.com'), ('${P.bea}', 'b@example.com');
    insert into public.families (id, name, created_by) values ('${F.a}', 'A', '${P.hasan}'), ('${F.b}', 'B', '${P.hasan}');
    insert into public.profiles (id, family_id, role, is_app_owner, display_name) values
      ('${P.hasan}', '${F.a}', 'admin', true, 'Hasan'),
      ('${P.amir}', '${F.a}', 'member', false, 'Amir'),
      ('${P.bea}', '${F.b}', 'admin', false, 'Bea');
    insert into public.memories (id, owner_id, content, about, status) values
      ('${M.amirDad}', '${P.amir}', 'Amir''s dad is 52', 'dad', 'active'),
      ('${M.beaOne}', '${P.bea}', 'Bea is a nurse', 'me', 'active');
  `);
});

describe("smart memory", () => {
  it("who a memory is about is hidden from the family admin and the app owner", async () => {
    expect(await rows(db, P.amir, "select about from memories")).toEqual([{ about: "dad" }]);
    expect(await rows(db, P.hasan, "select about from memories where owner_id = $1", [P.amir])).toEqual([]);
  });

  it("a person can label and replace their own memories", async () => {
    await as(db, P.amir, (tx) =>
      tx.query("insert into memories (id, owner_id, content, about, status) values ($1, $2, 'Amir''s dad is 53', 'dad', 'active')", [M.amirNew, P.amir]),
    );
    await as(db, P.amir, (tx) => tx.query("update memories set status = 'archived', replaced_by = $1 where id = $2", [M.amirNew, M.amirDad]));
    expect(await rows(db, P.amir, "select status, replaced_by from memories where id = $1", [M.amirDad])).toEqual([{ status: "archived", replaced_by: M.amirNew }]);
    // Undo brings it back.
    await as(db, P.amir, (tx) => tx.query("update memories set status = 'active', replaced_by = null, about = 'father' where id = $1", [M.amirDad]));
    expect(await rows(db, P.amir, "select status, about from memories where id = $1", [M.amirDad])).toEqual([{ status: "active", about: "father" }]);
  });

  it("a memory can't be replaced by someone else's", async () => {
    await expect(as(db, P.amir, (tx) => tx.query("update memories set replaced_by = $1 where id = $2", [M.beaOne, M.amirDad]))).rejects.toThrow(/one of your own/);
    await expect(
      as(db, P.amir, (tx) => tx.query("insert into memories (owner_id, content, replaced_by) values ($1, 'x', $2)", [P.amir, M.beaOne])),
    ).rejects.toThrow(/one of your own/);
  });

  it("nobody can label or replace someone else's memories", async () => {
    await as(db, P.hasan, (tx) => tx.query("update memories set about = 'hacked', status = 'archived' where id = $1", [M.amirDad]));
    expect(await rows(db, P.amir, "select about, status from memories where id = $1", [M.amirDad])).toEqual([{ about: "father", status: "active" }]);
  });

  it("labels stay short", async () => {
    await expect(as(db, P.amir, (tx) => tx.query("update memories set about = $1 where id = $2", ["x".repeat(81), M.amirDad]))).rejects.toThrow(/check/);
    await expect(as(db, P.amir, (tx) => tx.query("update memories set about = '' where id = $1", [M.amirDad]))).rejects.toThrow(/check/);
  });

  it("the replacement check can't be called directly", async () => {
    await expect(rows(db, P.amir, "select public.memories_same_owner_replacement()")).rejects.toThrow();
  });
});
