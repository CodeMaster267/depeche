import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDatabase, rows } from "./harness";

/** Voice notes waiting to be written out: each person reaches only their own, and leftovers go. */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2) };
const F = id(101);

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
    insert into storage.objects (bucket_id, name, created_at) values
      ('voice-notes', '${P.amir}/a/old.m4a', now() - interval '2 days'),
      ('voice-notes', '${P.amir}/b/new.m4a', now()),
      ('voice-notes', '${P.hasan}/c/hasans.mp3', now()),
      ('uploads', '${P.amir}/d/photo.jpg', now() - interval '2 days');
  `);
});

describe("voice notes storage", () => {
  it("is a private bucket for recordings only, capped at 25 MB", async () => {
    const [b] = await asServer<{ public: boolean; file_size_limit: number; types: string[] }>(
      "select public, file_size_limit, allowed_mime_types as types from storage.buckets where id = 'voice-notes'",
    );
    expect(b.public).toBe(false);
    expect(Number(b.file_size_limit)).toBe(25 * 1024 * 1024);
    expect(b.types.every((t) => t.startsWith("audio/"))).toBe(true);
    expect(b.types).toEqual(expect.arrayContaining(["audio/mp4", "audio/mpeg", "audio/ogg"]));
  });

  it("shows each person only their own recordings; the family admin and signed-out people see none", async () => {
    const mine = await rows<{ name: string }>(db, P.amir, "select name from storage.objects where bucket_id = 'voice-notes' order by name");
    expect(mine.map((r) => r.name)).toEqual([`${P.amir}/a/old.m4a`, `${P.amir}/b/new.m4a`]);
    const admin = await rows<{ name: string }>(db, P.hasan, "select name from storage.objects where bucket_id = 'voice-notes'");
    expect(admin.map((r) => r.name)).toEqual([`${P.hasan}/c/hasans.mp3`]);
    expect(await rows(db, null, "select name from storage.objects where bucket_id = 'voice-notes'")).toEqual([]);
  });

  it("lets people add recordings to their own folder only", async () => {
    await as(db, P.amir, (tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('voice-notes', $1)`, [`${P.amir}/e/ok.m4a`]));
    await expect(
      as(db, P.amir, (tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('voice-notes', $1)`, [`${P.hasan}/f/sneaky.m4a`])),
    ).rejects.toThrow(/row-level security/);
    await expect(
      as(db, null, (tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('voice-notes', $1)`, [`${P.amir}/g/anon.m4a`])),
    ).rejects.toThrow(/row-level security/);
  });

  it("can't delete someone else's recording", async () => {
    await as(db, P.hasan, (tx) => tx.query(`delete from storage.objects where bucket_id = 'voice-notes' and name like $1`, [`${P.amir}/%`]));
    expect(await asServer(`select count(*)::int as n from storage.objects where bucket_id = 'voice-notes' and name like $1`, [`${P.amir}/%`])).toEqual([
      { n: 3 },
    ]);
  });

  it("finds recordings left over for more than a day, for the server only", async () => {
    const due = await asServer<{ p: string }>("select * from public.expired_voice_notes() as p");
    expect(due.map((r) => r.p)).toEqual([`${P.amir}/a/old.m4a`]);
    await expect(rows(db, P.amir, "select * from public.expired_voice_notes()")).rejects.toThrow(/permission denied/);
  });
});
