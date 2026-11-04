import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDatabase, rows } from "./harness";

/** The Health screen's functions: counts and dates only, each admin their own family, the owner the system. */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2), bea: id(3), ben: id(4) };
const F = { a: id(101), b: id(102) };
const C = { amir: id(201), ben: id(202) };

let db: PGlite;
async function server<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return db.transaction(async (tx) => {
    await tx.exec("set local role service_role");
    return (await tx.query<T>(sql, params)).rows;
  });
}

beforeAll(async () => {
  db = await freshDatabase();
  await db.exec(`
    insert into auth.users (id, email) values
      ('${P.hasan}', 'hasan@example.com'), ('${P.amir}', 'amir@example.com'),
      ('${P.bea}', 'bea@example.com'), ('${P.ben}', 'ben@example.com');
    insert into public.families (id, name, created_by) values ('${F.a}', 'A', '${P.hasan}'), ('${F.b}', 'B', '${P.hasan}');
    insert into public.profiles (id, family_id, role, is_app_owner, display_name) values
      ('${P.hasan}', '${F.a}', 'admin', true, 'Hasan'), ('${P.amir}', '${F.a}', 'member', false, 'Amir'),
      ('${P.bea}', '${F.b}', 'admin', false, 'Bea'), ('${P.ben}', '${F.b}', 'member', false, 'Ben');
    insert into public.provider_keys (family_id, provider, ciphertext, last4, created_by) values
      ('${F.a}', 'google', '\\x00', 'aaaa', '${P.hasan}'), ('${F.b}', 'google', '\\x00', 'bbbb', '${P.bea}');
    insert into public.chats (id, owner_id, title) values ('${C.amir}', '${P.amir}', 'x'), ('${C.ben}', '${P.ben}', 'y');
    insert into public.messages (chat_id, owner_id, role, content, status, provider) values
      ('${C.amir}', '${P.amir}', 'assistant', '{"text":"secret"}', 'completed', 'google'),
      ('${C.amir}', '${P.amir}', 'assistant', '{"text":""}', 'failed', 'google'),
      ('${C.ben}', '${P.ben}', 'assistant', '{"text":"b"}', 'failed', 'google'),
      ('${C.ben}', '${P.ben}', 'assistant', '{"text":"b"}', 'failed', 'google');
    insert into public.system_checks (kind, ok, detail, created_at) values
      ('backup', true, 'first', now() - interval '2 days'), ('backup', false, 'broke', now());
  `);
});

describe("family health", () => {
  it("counts only the admin's own family's replies, and returns no content", async () => {
    const [a] = await server("select * from family_health($1)", [P.hasan]);
    expect(a).toMatchObject({ provider: "google", replies_24h: 2, failed_24h: 1 });
    expect(JSON.stringify(a)).not.toContain("secret");
    const [b] = await server("select * from family_health($1)", [P.bea]);
    expect(b).toMatchObject({ provider: "google", replies_24h: 2, failed_24h: 2 });
  });

  it("is refused for members", async () => {
    await expect(server("select * from family_health($1)", [P.amir])).rejects.toThrow(/Only a family admin/);
    await expect(server("select * from latest_checks($1)", [P.amir])).rejects.toThrow(/Only a family admin/);
  });

  it("shows the latest result of each check, and when it last succeeded", async () => {
    const [c] = await server<{ kind: string; ok: boolean; detail: string; last_ok_at: Date }>("select * from latest_checks($1)", [P.bea]);
    expect(c).toMatchObject({ kind: "backup", ok: false, detail: "broke" });
    expect(c.last_ok_at).toBeTruthy();
  });
});

describe("system health", () => {
  it("is for the owner only", async () => {
    const [s] = await server("select families, people, replies_24h, failed_24h from system_health($1)", [P.hasan]);
    expect(s).toEqual({ families: 2, people: 4, replies_24h: 4, failed_24h: 3 });
    await expect(server("select * from system_health($1)", [P.bea])).rejects.toThrow(/Only the owner/);
  });

  it("nobody can call any of it from the browser", async () => {
    for (const sql of [
      `select * from family_health('${P.hasan}')`,
      `select * from latest_checks('${P.hasan}')`,
      `select * from system_health('${P.hasan}')`,
      "select * from provider_failures_24h()",
      "select * from system_checks",
    ]) {
      for (const who of [null, P.hasan]) await expect(rows(db, who, sql)).rejects.toThrow(/permission denied/);
    }
  });
});
