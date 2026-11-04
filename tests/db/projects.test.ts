import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDatabase, rows } from "./harness";

/**
 * Projects: each person's own folders of chats, with instructions and files. Nobody else sees a
 * project, not even a family admin who can see the member's chat titles, and a chat can only go
 * into a project of its own owner.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2), sara: id(3) };
const F = id(101);
const C = { amir: id(201), amirOld: id(202), sara: id(203) };
const J = { amir: id(301), sara: id(302) };

let db: PGlite;

async function asServer<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return db.transaction(async (tx) => {
    await tx.exec("set local role service_role");
    return (await tx.query<T>(sql, params)).rows;
  });
}

const run = async (person: string | null, sql: string, params: unknown[] = []) =>
  (await as(db, person, (tx) => tx.query(sql, params))).affectedRows ?? 0;

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
    insert into public.chats (id, owner_id, title, updated_at) values
      ('${C.amir}', '${P.amir}', 'Titration notes', now()),
      ('${C.amirOld}', '${P.amir}', 'Old notes', now() - interval '40 days'),
      ('${C.sara}', '${P.sara}', 'Sara chat', now());
  `);
});

describe("projects", () => {
  it("lets a person make, rename and give instructions to their own project", async () => {
    expect(
      await run(P.amir, "insert into projects (id, owner_id, name) values ($1, $2, 'Chemistry')", [J.amir, P.amir]),
    ).toBe(1);
    expect(await run(P.amir, "update projects set instructions = 'Explain like a tutor' where id = $1", [J.amir])).toBe(1);
    expect(await run(P.sara, "insert into projects (id, owner_id, name) values ($1, $2, 'Trip')", [J.sara, P.sara])).toBe(1);
    expect(await rows(db, P.amir, "select name, instructions from projects")).toEqual([
      { name: "Chemistry", instructions: "Explain like a tutor" },
    ]);
  });

  it("can't be made for someone else", async () => {
    await expect(
      as(db, P.amir, (tx) => tx.query("insert into projects (owner_id, name) values ($1, 'Sneaky')", [P.sara])),
    ).rejects.toThrow(/row-level security/);
  });

  it("is invisible to everyone else, including the family admin and the app owner", async () => {
    expect(await rows(db, P.hasan, "select * from projects")).toEqual([]);
    expect(await rows(db, P.sara, "select name from projects")).toEqual([{ name: "Trip" }]);
    await expect(rows(db, null, "select * from projects")).rejects.toThrow(/permission denied/);
    expect(await run(P.hasan, "update projects set name = 'mine' where id = $1", [J.amir])).toBe(0);
    expect(await run(P.sara, "update projects set instructions = 'x' where id = $1", [J.amir])).toBe(0);
    expect(await run(P.hasan, "delete from projects where id = $1", [J.amir])).toBe(0);
  });

  it("can't be handed to someone else", async () => {
    await expect(
      as(db, P.amir, (tx) => tx.query("update projects set owner_id = $2 where id = $1", [J.amir, P.sara])),
    ).rejects.toThrow(/permission denied/);
  });

  it("takes the owner's chats in and out", async () => {
    expect(await run(P.amir, "update chats set project_id = $1 where id = $2", [J.amir, C.amir])).toBe(1);
    expect(await rows(db, P.amir, "select project_id from chats where id = $1", [C.amir])).toEqual([{ project_id: J.amir }]);
    expect(await run(P.amir, "update chats set project_id = null where id = $1", [C.amir])).toBe(1);
    expect(await run(P.amir, "update chats set project_id = $1 where id = $2", [J.amir, C.amir])).toBe(1);
  });

  it("won't put a chat in someone else's project", async () => {
    await expect(
      as(db, P.amir, (tx) => tx.query("update chats set project_id = $1 where id = $2", [J.sara, C.amir])),
    ).rejects.toThrow(/foreign key/);
    // Nor can anyone move a chat that isn't theirs.
    expect(await run(P.sara, "update chats set project_id = $1 where id = $2", [J.sara, C.amir])).toBe(0);
    expect(await run(P.hasan, "update chats set project_id = null where id = $1", [C.amir])).toBe(0);
  });
});

describe("project files", () => {
  it("are kept only in the owner's own folder", async () => {
    expect(
      await run(
        P.amir,
        "insert into project_files (project_id, owner_id, path, name, mime, size) values ($1, $2, $3, 'syllabus.pdf', 'application/pdf', 100)",
        [J.amir, P.amir, `${P.amir}/p1/syllabus.pdf`],
      ),
    ).toBe(1);
    await expect(
      as(db, P.amir, (tx) =>
        tx.query(
          "insert into project_files (project_id, owner_id, path, name, mime, size) values ($1, $2, $3, 'x.pdf', 'application/pdf', 1)",
          [J.amir, P.amir, `${P.sara}/x/x.pdf`],
        ),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("can't be added to someone else's project", async () => {
    await expect(
      as(db, P.amir, (tx) =>
        tx.query(
          "insert into project_files (project_id, owner_id, path, name, mime, size) values ($1, $2, $3, 'x.pdf', 'application/pdf', 1)",
          [J.sara, P.amir, `${P.amir}/x/x.pdf`],
        ),
      ),
    ).rejects.toThrow(/foreign key/);
    await expect(
      as(db, P.amir, (tx) =>
        tx.query(
          "insert into project_files (project_id, owner_id, path, name, mime, size) values ($1, $2, $3, 'x.pdf', 'application/pdf', 1)",
          [J.sara, P.sara, `${P.sara}/x/x.pdf`],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("are invisible to everyone else", async () => {
    expect(await rows(db, P.hasan, "select * from project_files")).toEqual([]);
    expect(await rows(db, P.sara, "select * from project_files")).toEqual([]);
    expect(await run(P.sara, "delete from project_files")).toBe(0);
    expect(await rows(db, P.amir, "select name from project_files")).toEqual([{ name: "syllabus.pdf" }]);
  });

  it("are not cleaned up after 3 days while the project has them", async () => {
    await asServer(`
      insert into storage.objects (bucket_id, name, created_at) values
        ('uploads', '${P.amir}/p1/syllabus.pdf', now() - interval '10 days'),
        ('uploads', '${P.amir}/p2/loose.pdf', now() - interval '10 days')
    `);
    const due = await asServer<{ name: string }>("select public.expired_uploads() as name");
    expect(due.map((r) => r.name)).toEqual([`${P.amir}/p2/loose.pdf`]);
  });
});

describe("clean-up and deleting", () => {
  it("keeps chats in a project from the monthly clean-up", async () => {
    await run(P.amir, "update chats set project_id = $1 where id = $2", [J.amir, C.amirOld]);
    await asServer("select public.expire_old_chats()");
    expect(await asServer("select title from chats where id = $1", [C.amirOld])).toEqual([{ title: "Old notes" }]);
  });

  it("moves a deleted project's chats back to the main list, and drops its file list", async () => {
    expect(await run(P.amir, "delete from projects where id = $1", [J.amir])).toBe(1);
    expect(await asServer("select title, project_id, owner_id from chats where owner_id = $1 order by title", [P.amir])).toEqual([
      { title: "Old notes", project_id: null, owner_id: P.amir },
      { title: "Titration notes", project_id: null, owner_id: P.amir },
    ]);
    expect(await asServer("select * from project_files")).toEqual([]);
    // Its files are now unused, so the next clean-up removes them.
    const due = await asServer<{ name: string }>("select public.expired_uploads() as name");
    expect(due.map((r) => r.name).sort()).toEqual([`${P.amir}/p1/syllabus.pdf`, `${P.amir}/p2/loose.pdf`]);
  });
});
