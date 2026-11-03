import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDatabase, rows } from "./harness";

/** Uploads: each person reaches only their own folder, and old files are found for deleting. */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2) };
const F = id(101);
const C = { active: id(201), idle: id(202) };

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
    insert into auth.users (id, email) values ('${P.hasan}', 'h@example.com'), ('${P.amir}', 'a@example.com');
    insert into public.families (id, name, created_by) values ('${F}', 'Family', '${P.hasan}');
    insert into public.profiles (id, family_id, role, is_app_owner, display_name) values
      ('${P.hasan}', '${F}', 'admin', true, 'Hasan'), ('${P.amir}', '${F}', 'member', false, 'Amir');
    insert into public.chats (id, owner_id, title, updated_at) values
      ('${C.active}', '${P.amir}', 'Active', now() - interval '1 day'),
      ('${C.idle}', '${P.amir}', 'Idle', now() - interval '4 days');
    insert into storage.objects (bucket_id, name, created_at) values
      ('uploads', '${P.amir}/a/in-active-chat.jpg', now() - interval '5 days'),
      ('uploads', '${P.amir}/b/in-idle-chat.jpg', now() - interval '5 days'),
      ('uploads', '${P.amir}/c/never-sent.pdf', now() - interval '2 days'),
      ('uploads', '${P.amir}/d/just-uploaded.pdf', now()),
      ('uploads', '${P.hasan}/e/hasans.png', now());
    insert into public.messages (chat_id, owner_id, role, content) values
      ('${C.active}', '${P.amir}', 'user', '{"text":"look","files":[{"path":"${P.amir}/a/in-active-chat.jpg","name":"x.jpg"}]}'),
      ('${C.idle}', '${P.amir}', 'user', '{"text":"look","files":[{"path":"${P.amir}/b/in-idle-chat.jpg","name":"y.jpg"}]}');
  `);
});

describe("upload storage", () => {
  it("is a private bucket capped at 10 MB", async () => {
    expect(await asServer("select public, file_size_limit from storage.buckets where id = 'uploads'")).toEqual([
      { public: false, file_size_limit: 10485760 },
    ]);
  });

  it("shows each person only their own files", async () => {
    const names = await rows<{ name: string }>(db, P.hasan, "select name from storage.objects order by name");
    expect(names.map((r) => r.name)).toEqual([`${P.hasan}/e/hasans.png`]);
    expect(await rows(db, null, "select name from storage.objects")).toEqual([]);
  });

  it("lets people upload into their own folder only", async () => {
    await as(db, P.hasan, (tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('uploads', $1)`, [`${P.hasan}/f/ok.png`]));
    await expect(
      as(db, P.hasan, (tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('uploads', $1)`, [`${P.amir}/g/sneaky.png`])),
    ).rejects.toThrow(/row-level security/);
    await expect(
      as(db, null, (tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('uploads', $1)`, [`${P.amir}/g/anon.png`])),
    ).rejects.toThrow(/row-level security/);
  });

  it("can't delete someone else's file", async () => {
    await as(db, P.hasan, (tx) => tx.query(`delete from storage.objects where name like $1`, [`${P.amir}/%`]));
    expect(await asServer(`select count(*)::int as n from storage.objects where name like $1`, [`${P.amir}/%`])).toEqual([{ n: 4 }]);
  });
});

describe("old uploads", () => {
  it("are those in chats unused for 3 days, and ones never sent after a day", async () => {
    const due = await asServer<{ p: string }>("select * from public.expired_uploads() as p");
    expect(due.map((r) => r.p).sort()).toEqual([`${P.amir}/b/in-idle-chat.jpg`, `${P.amir}/c/never-sent.pdf`]);
  });

  it("can only be listed by the server", async () => {
    await expect(rows(db, P.hasan, "select * from public.expired_uploads()")).rejects.toThrow(/permission denied/);
  });
});
