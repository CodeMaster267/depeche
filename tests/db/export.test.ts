import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDatabase, rows } from "./harness";

/**
 * "Download everything" runs in the browser as the signed-in person. These are the reads it makes
 * (lib/export/collect.ts): each person gets only their own data, and an admin, who can see members'
 * chat titles and spending, gets none of that in their own export.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2), other: id(3) };
const F = { mine: id(101), theirs: id(102) };
const C = { hasan: id(201), amir: id(202), other: id(203) };
const M = { hasan: id(301), amir: id(302), other: id(303) };

let db: PGlite;

beforeAll(async () => {
  db = await freshDatabase();
  await db.exec(`
    insert into auth.users (id, email) values ('${P.hasan}', 'h@example.com'), ('${P.amir}', 'a@example.com'), ('${P.other}', 'o@example.com');
    insert into public.families (id, name, created_by) values ('${F.mine}', 'Mine', '${P.hasan}'), ('${F.theirs}', 'Theirs', '${P.hasan}');
    insert into public.profiles (id, family_id, role, is_app_owner, display_name, share_titles) values
      ('${P.hasan}', '${F.mine}', 'admin', true, 'Hasan', false),
      ('${P.amir}', '${F.mine}', 'member', false, 'Amir', true),
      ('${P.other}', '${F.theirs}', 'admin', false, 'Other', true);
    insert into public.chats (id, owner_id, title) values
      ('${C.hasan}', '${P.hasan}', 'Hasan chat'), ('${C.amir}', '${P.amir}', 'Amir chat'), ('${C.other}', '${P.other}', 'Other chat');
    insert into public.messages (id, chat_id, owner_id, role, content) values
      ('${M.hasan}', '${C.hasan}', '${P.hasan}', 'user', '{"text":"hasan secret"}'),
      ('${M.amir}', '${C.amir}', '${P.amir}', 'user', '{"text":"amir secret","files":[{"path":"${P.amir}/x/a.png","name":"a.png"}]}'),
      ('${M.other}', '${C.other}', '${P.other}', 'user', '{"text":"other secret"}');
    insert into public.memories (owner_id, content, status) values
      ('${P.hasan}', 'hasan memory', 'active'), ('${P.amir}', 'amir memory', 'active'), ('${P.other}', 'other memory', 'active');
    insert into public.usage_events (owner_id, message_id, provider, model, input_tokens, output_tokens, cost_usd) values
      ('${P.hasan}', '${M.hasan}', 'openai', 'm', 1, 1, 0.01), ('${P.amir}', '${M.amir}', 'openai', 'm', 1, 1, 0.02);
    insert into storage.objects (bucket_id, name) values ('uploads', '${P.hasan}/y/h.png'), ('uploads', '${P.amir}/x/a.png');
  `);
});

/** The export's reads for `who`, as `as` (normally the same person). */
async function exportAs(as: string, who: string) {
  const q = (sql: string) => rows(db, as, sql, [who]);
  return {
    chats: (await q("select title from public.chats where owner_id = $1")).map((r) => r.title),
    messages: (await q("select content->>'text' as t from public.messages where owner_id = $1")).map((r) => r.t),
    memories: (await q("select content from public.memories where owner_id = $1")).map((r) => r.content),
    usage: (await q("select cost_usd::text as c from public.usage_events where owner_id = $1")).map((r) => r.c),
    profile: (await q("select display_name from public.profiles where id = $1")).map((r) => r.display_name),
    files: (await q("select name from storage.objects where bucket_id = 'uploads' and name like $1 || '/%'")).map((r) => r.name),
  };
}

describe("download everything", () => {
  it("gives each person all of their own data", async () => {
    expect(await exportAs(P.amir, P.amir)).toEqual({
      chats: ["Amir chat"], messages: ["amir secret"], memories: ["amir memory"], usage: ["0.020000"], profile: ["Amir"], files: [`${P.amir}/x/a.png`],
    });
    expect(await exportAs(P.hasan, P.hasan)).toEqual({
      chats: ["Hasan chat"], messages: ["hasan secret"], memories: ["hasan memory"], usage: ["0.010000"], profile: ["Hasan"], files: [`${P.hasan}/y/h.png`],
    });
  });

  it("never lets an admin export a member's messages, memories or files", async () => {
    const got = await exportAs(P.hasan, P.amir);
    expect(got.messages).toEqual([]);
    expect(got.memories).toEqual([]);
    expect(got.files).toEqual([]);
    // What an admin may see anyway (titles shared, spending) is why the export filters by owner.
    expect(got.chats).toEqual(["Amir chat"]);
    expect(got.usage).toEqual(["0.020000"]);
  });

  it("lets no one export another family's or their admin's data", async () => {
    const empty = { chats: [], messages: [], memories: [], usage: [], profile: [], files: [] };
    expect(await exportAs(P.hasan, P.other)).toEqual(empty);
    expect({ ...(await exportAs(P.amir, P.hasan)), profile: [] }).toEqual(empty); // family names are visible, nothing else
    expect(await exportAs(P.other, P.amir)).toEqual(empty);
  });

  it("gives a signed-out visitor nothing", async () => {
    const q = (sql: string) => rows(db, null, sql).catch(() => []);
    for (const t of ["public.chats", "public.messages", "public.memories", "public.usage_events", "storage.objects"]) {
      expect(await q(`select * from ${t}`)).toEqual([]);
    }
  });
});
