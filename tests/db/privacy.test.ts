import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDatabase, rows } from "./harness";

/**
 * Two families. Hasan owns the app and is admin of family A. Hasan created family B,
 * whose admin is Bea. Each family has one ordinary member with a private chat.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = {
  hasan: id(1), // app owner, admin of family A
  amir: id(2),  // member of family A (a teenager)
  bea: id(3),   // admin of family B
  ben: id(4),   // member of family B
};
const F = { a: id(101), b: id(102) };
const C = { amir: id(201), ben: id(202) };
const M = { amir: id(301), ben: id(302) };

let db: PGlite;

beforeAll(async () => {
  db = await freshDatabase();
  // Fixtures are written the way the server would write them: as service_role.
  await db.exec(`
    insert into auth.users (id, email) values
      ('${P.hasan}', 'hasan@example.com'), ('${P.amir}', 'amir@example.com'),
      ('${P.bea}', 'bea@example.com'), ('${P.ben}', 'ben@example.com');
    insert into public.families (id, name, created_by) values
      ('${F.a}', 'Family A', '${P.hasan}'), ('${F.b}', 'Friends B', '${P.hasan}');
    insert into public.profiles (id, family_id, role, is_app_owner, display_name, monthly_cap_usd) values
      ('${P.hasan}', '${F.a}', 'admin',  true,  'Hasan', 50),
      ('${P.amir}',  '${F.a}', 'member', false, 'Amir',  10),
      ('${P.bea}',   '${F.b}', 'admin',  false, 'Bea',   20),
      ('${P.ben}',   '${F.b}', 'member', false, 'Ben',   10);
    insert into public.provider_keys (family_id, provider, ciphertext, last4, created_by) values
      ('${F.a}', 'anthropic', '\\xdeadbeef', 'a1b2', '${P.hasan}'),
      ('${F.b}', 'openai',    '\\xcafebabe', 'z9y8', '${P.bea}');
    insert into public.chats (id, owner_id, title) values
      ('${C.amir}', '${P.amir}', 'Chemistry revision'),
      ('${C.ben}',  '${P.ben}',  'Ben private chat');
    insert into public.messages (id, chat_id, owner_id, role, content) values
      ('${M.amir}', '${C.amir}', '${P.amir}', 'user', '{"text":"Amir secret question"}'),
      ('${M.ben}',  '${C.ben}',  '${P.ben}',  'user', '{"text":"Ben secret question"}');
    insert into public.memories (owner_id, content, status) values
      ('${P.amir}', 'Amir has a chemistry exam in June', 'active'),
      ('${P.ben}',  'Ben is allergic to peanuts', 'active');
    insert into public.usage_events (owner_id, message_id, provider, model, input_tokens, output_tokens, cost_usd) values
      ('${P.amir}', '${M.amir}', 'anthropic', 'claude-sonnet-5-5', 100, 200, 0.004),
      ('${P.ben}',  '${M.ben}',  'openai',    'gpt',               100, 200, 0.003);
    insert into public.invites (family_id, email, role, invited_by, token_hash, expires_at) values
      ('${F.b}', 'newfriend@example.com', 'member', '${P.bea}', 'hash-b', now() + interval '7 days');
  `);
});

describe("members", () => {
  it("see only their own chats", async () => {
    expect(await rows(db, P.amir, "select id from chats")).toEqual([{ id: C.amir }]);
    expect(await rows(db, P.ben, "select id from chats")).toEqual([{ id: C.ben }]);
  });

  it("cannot read another person's messages even with the chat id", async () => {
    expect(await rows(db, P.amir, "select * from messages where chat_id = $1", [C.ben])).toEqual([]);
    expect(await rows(db, P.amir, "select * from messages where id = $1", [M.ben])).toEqual([]);
  });

  it("cannot read another person's memories or usage", async () => {
    const mem = await rows<{ content: string }>(db, P.amir, "select content from memories");
    expect(mem.map((m) => m.content)).toEqual(["Amir has a chemistry exam in June"]);
    const use = await rows<{ owner_id: string }>(db, P.amir, "select owner_id from usage_events");
    expect(use.map((u) => u.owner_id)).toEqual([P.amir]);
  });

  it("cannot create a chat in someone else's name", async () => {
    await expect(
      as(db, P.amir, (tx) => tx.query("insert into chats (owner_id, title) values ($1, 'x')", [P.ben])),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot post a message into someone else's chat", async () => {
    await expect(
      as(db, P.amir, (tx) =>
        tx.query(
          `insert into messages (chat_id, owner_id, role, content) values ($1, $2, 'user', '{}')`,
          [C.ben, P.amir],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot write an assistant reply themselves (only the server can)", async () => {
    await expect(
      as(db, P.amir, (tx) =>
        tx.query(
          `insert into messages (chat_id, owner_id, role, content) values ($1, $2, 'assistant', '{}')`,
          [C.amir, P.amir],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot edit or delete messages, so history is never overwritten", async () => {
    await expect(
      as(db, P.amir, (tx) => tx.query(`update messages set content = '{}' where id = $1`, [M.amir])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(db, P.amir, (tx) => tx.query(`delete from messages where id = $1`, [M.amir])),
    ).rejects.toThrow(/permission denied/);
  });

  it("cannot record usage, so nobody can forge or erase spending", async () => {
    await expect(
      as(db, P.amir, (tx) =>
        tx.query(
          `insert into usage_events (owner_id, provider, model, input_tokens, output_tokens, cost_usd)
           values ($1, 'x', 'x', 0, 0, 0)`,
          [P.amir],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("cannot raise their own cap, make themselves admin, or become app owner", async () => {
    for (const sql of [
      "update profiles set monthly_cap_usd = 9999 where id = $1",
      "update profiles set role = 'admin' where id = $1",
      "update profiles set is_app_owner = true where id = $1",
      "update profiles set family_id = '" + F.b + "' where id = $1",
    ]) {
      await expect(as(db, P.amir, (tx) => tx.query(sql, [P.amir]))).rejects.toThrow(/permission denied/);
    }
  });

  it("can rename themselves", async () => {
    await as(db, P.amir, (tx) => tx.query("update profiles set display_name = 'Amir K' where id = $1", [P.amir]));
    expect(await rows(db, P.amir, "select display_name from profiles where id = $1", [P.amir])).toEqual([
      { display_name: "Amir K" },
    ]);
  });

  it("cannot see provider keys at all", async () => {
    expect(await rows(db, P.amir, "select id from provider_keys")).toEqual([]);
  });
});

describe("family admins", () => {
  it("see no chat titles unless the member chooses to share them", async () => {
    expect(await rows(db, P.hasan, "select title from chats")).toEqual([]);
    // Amir turns sharing on for himself, through his own session.
    await as(db, P.amir, (tx) => tx.query("update profiles set share_titles = true where id = $1", [P.amir]));
    const titles = await rows<{ title: string }>(db, P.hasan, "select title from chats");
    expect(titles.map((t) => t.title)).toEqual(["Chemistry revision"]);
    await as(db, P.amir, (tx) => tx.query("update profiles set share_titles = false where id = $1", [P.amir]));
    expect(await rows(db, P.hasan, "select title from chats")).toEqual([]);
  });

  it("cannot switch title sharing on for a member", async () => {
    await as(db, P.hasan, (tx) => tx.query("update profiles set share_titles = true where id = $1", [P.amir]));
    expect(await rows(db, P.amir, "select share_titles from profiles where id = $1", [P.amir])).toEqual([
      { share_titles: false },
    ]);
  });

  it("never see their members' messages or memories", async () => {
    expect(await rows(db, P.hasan, "select * from messages")).toEqual([]);
    expect(await rows(db, P.hasan, "select * from memories")).toEqual([]);
  });

  it("see their members' spending", async () => {
    const use = await rows<{ owner_id: string }>(db, P.hasan, "select owner_id from usage_events");
    expect(use.map((u) => u.owner_id)).toEqual([P.amir]);
  });

  it("see only the last four characters of their family's keys", async () => {
    expect(await rows(db, P.hasan, "select provider, last4 from provider_keys")).toEqual([
      { provider: "anthropic", last4: "a1b2" },
    ]);
    await expect(as(db, P.hasan, (tx) => tx.query("select ciphertext from provider_keys"))).rejects.toThrow(
      /permission denied/,
    );
  });

  it("cannot store or change keys directly (only the server can)", async () => {
    await expect(
      as(db, P.hasan, (tx) =>
        tx.query(
          `insert into provider_keys (family_id, provider, ciphertext, last4, created_by)
           values ($1, 'openai', '\\x00', 'abcd', $2)`,
          [F.a, P.hasan],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("cannot see another family's members, chats, usage, keys or invites", async () => {
    expect(await rows(db, P.bea, "select display_name from profiles order by display_name")).toEqual([
      { display_name: "Bea" },
      { display_name: "Ben" },
    ]);
    // Even a member who shares titles shares them only with their own family's admin.
    await db.exec(`update profiles set share_titles = true where id in ('${P.amir}', '${P.ben}')`);
    expect((await rows<{ title: string }>(db, P.bea, "select title from chats")).map((t) => t.title)).toEqual([
      "Ben private chat",
    ]);
    expect(await rows(db, P.bea, "select * from chats where owner_id = $1", [P.amir])).toEqual([]);
    await db.exec(`update profiles set share_titles = false`);
    expect(await rows(db, P.bea, "select * from usage_events where owner_id = $1", [P.amir])).toEqual([]);
    expect((await rows<{ last4: string }>(db, P.bea, "select last4 from provider_keys")).map((k) => k.last4)).toEqual([
      "z9y8",
    ]);
  });
});

describe("the app owner", () => {
  it("sees nothing inside a family they created but do not belong to", async () => {
    expect(await rows(db, P.hasan, "select * from profiles where family_id = $1", [F.b])).toEqual([]);
    expect(await rows(db, P.hasan, "select * from chats where owner_id = $1", [P.ben])).toEqual([]);
    expect(await rows(db, P.hasan, "select * from messages where owner_id = $1", [P.ben])).toEqual([]);
    expect(await rows(db, P.hasan, "select * from memories where owner_id = $1", [P.ben])).toEqual([]);
    expect(await rows(db, P.hasan, "select * from usage_events where owner_id = $1", [P.ben])).toEqual([]);
    expect(await rows(db, P.hasan, "select id, last4 from provider_keys where family_id = $1", [F.b])).toEqual([]);
    expect(await rows(db, P.hasan, "select id, email from invites where family_id = $1", [F.b])).toEqual([]);
  });

  it("sees only the name of a family they created", async () => {
    const fams = await rows<{ name: string }>(db, P.hasan, "select name from families order by name");
    expect(fams.map((f) => f.name)).toEqual(["Family A", "Friends B"]);
  });

  it("cannot rename a family they do not belong to", async () => {
    await as(db, P.hasan, (tx) => tx.query("update families set name = 'Hijacked' where id = $1", [F.b]));
    const [fam] = await rows<{ name: string }>(db, P.bea, "select name from families where id = $1", [F.b]);
    expect(fam.name).toBe("Friends B");
  });
});

describe("visitors who are not signed in", () => {
  it("can read nothing", async () => {
    for (const table of ["families", "profiles", "invites", "provider_keys", "chats", "messages", "memories", "usage_events"]) {
      await expect(rows(db, null, `select * from ${table}`)).rejects.toThrow(/permission denied/);
    }
  });
});

describe("idempotent sends", () => {
  it("a retried send with the same request id creates only one message", async () => {
    const req = id(999);
    const send = () =>
      as(db, P.amir, (tx) =>
        tx.query(
          `insert into messages (chat_id, owner_id, role, content, client_request_id)
           values ($1, $2, 'user', '{"text":"hi"}', $3)
           on conflict (owner_id, client_request_id) do nothing`,
          [C.amir, P.amir, req],
        ),
      );
    await send();
    await send();
    const found = await rows(db, P.amir, "select id from messages where client_request_id = $1", [req]);
    expect(found).toHaveLength(1);
  });
});
