import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDatabase, rows } from "./harness";

/**
 * Chat: provider keys, model choice and spending. Hasan is admin of family A with member Amir;
 * Bea is admin of family B. Family A has an Anthropic and a Google key, family B an OpenAI key.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = { hasan: id(1), amir: id(2), bea: id(3) };
const F = { a: id(101), b: id(102) };

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
    insert into auth.users (id, email) values
      ('${P.hasan}', 'hasan@example.com'), ('${P.amir}', 'amir@example.com'), ('${P.bea}', 'bea@example.com');
    insert into public.families (id, name, created_by) values
      ('${F.a}', 'Family A', '${P.hasan}'), ('${F.b}', 'Friends B', '${P.hasan}');
    insert into public.profiles (id, family_id, role, is_app_owner, display_name) values
      ('${P.hasan}', '${F.a}', 'admin', true, 'Hasan'),
      ('${P.amir}', '${F.a}', 'member', false, 'Amir'),
      ('${P.bea}', '${F.b}', 'admin', false, 'Bea');
    insert into public.usage_events (owner_id, provider, model, input_tokens, output_tokens, cost_usd, created_at) values
      ('${P.amir}', 'anthropic', 'claude-sonnet-5-5', 10, 10, 1.25, now()),
      ('${P.amir}', 'anthropic', 'claude-sonnet-5-5', 10, 10, 0.50, now()),
      ('${P.amir}', 'anthropic', 'claude-sonnet-5-5', 10, 10, 9.00, now() - interval '62 days');
  `);
  await asServer(`select public.save_provider_key($1, 'anthropic', '\\x01'::bytea, 'a1b2')`, [P.hasan]);
  await asServer(`select public.save_provider_key($1, 'google', '\\x02'::bytea, 'g1g2')`, [P.hasan]);
  await asServer(`select public.save_provider_key($1, 'openai', '\\x03'::bytea, 'o1o2')`, [P.bea]);
});

describe("provider keys", () => {
  it("are stored into the admin's own family by the server", async () => {
    expect(await asServer("select family_id, provider, last4 from provider_keys order by provider")).toEqual([
      { family_id: F.a, provider: "anthropic", last4: "a1b2" },
      { family_id: F.a, provider: "google", last4: "g1g2" },
      { family_id: F.b, provider: "openai", last4: "o1o2" },
    ]);
  });

  it("accept only known providers, and no longer Groq", async () => {
    await expect(asServer(`select public.save_provider_key($1, 'groq', '\\x04'::bytea, 'gq12')`, [P.bea])).rejects.toThrow(/check/);
    await expect(asServer(`select public.save_provider_key($1, 'madeup', '\\x04'::bytea, 'zz12')`, [P.bea])).rejects.toThrow(/check/);
    expect(await asServer("select count(*)::int as n from provider_keys where provider = 'groq'")).toEqual([{ n: 0 }]);
  });

  it("accept DeepSeek and xAI keys", async () => {
    for (const provider of ["deepseek", "xai"]) {
      await asServer(`select public.save_provider_key($1, $2, '\\x05'::bytea, 'ds12')`, [P.bea, provider]);
      expect(await asServer("select family_id from provider_keys where provider = $1", [provider])).toEqual([{ family_id: F.b }]);
      await asServer(`select public.remove_provider_key($1, $2)`, [P.bea, provider]);
    }
    expect(await asServer("select count(*)::int as n from provider_keys where provider in ('deepseek', 'xai')")).toEqual([{ n: 0 }]);
  });

  it("can be replaced, keeping one key per provider", async () => {
    await asServer(`select public.save_provider_key($1, 'google', '\\x09'::bytea, 'g9g9')`, [P.hasan]);
    expect(await asServer("select last4 from provider_keys where provider = 'google'")).toEqual([{ last4: "g9g9" }]);
  });

  it("cannot be added by a member, even through the server", async () => {
    await expect(asServer(`select public.save_provider_key($1, 'openai', '\\x05'::bytea, 'zzzz')`, [P.amir])).rejects.toThrow(
      /Only a family admin/,
    );
  });

  it("cannot be added, removed or read from the browser", async () => {
    await expect(
      as(db, P.hasan, (tx) => tx.query(`select public.save_provider_key($1, 'openai', '\\x05'::bytea, 'zzzz')`, [P.hasan])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(db, P.hasan, (tx) => tx.query(`select public.remove_provider_key($1, 'google')`, [P.hasan])),
    ).rejects.toThrow(/permission denied/);
    await expect(as(db, P.amir, (tx) => tx.query("select last4 from provider_keys"))).resolves.toMatchObject({ rows: [] });
  });

  it("removing one only touches the admin's own family", async () => {
    await asServer(`select public.save_provider_key($1, 'openai', '\\x06'::bytea, 'o6o6')`, [P.hasan]);
    await asServer(`select public.remove_provider_key($1, 'openai')`, [P.hasan]);
    expect(await asServer("select family_id from provider_keys where provider = 'openai'")).toEqual([{ family_id: F.b }]);
  });
});

describe("which providers a family has", () => {
  it("members see their own family's provider names, and nothing else", async () => {
    expect(await rows(db, P.amir, "select * from public.family_providers() as p")).toEqual([
      { p: "anthropic" },
      { p: "google" },
    ]);
    expect(await rows(db, P.bea, "select * from public.family_providers() as p")).toEqual([{ p: "openai" }]);
  });

  it("visitors who are not signed in cannot ask", async () => {
    await expect(rows(db, null, "select * from public.family_providers()")).rejects.toThrow(/permission denied/);
  });
});

describe("which models a key can use", () => {
  it("are recorded by the server and shown to the family as model names only", async () => {
    await asServer(`select public.set_key_models($1, 'google', $2)`, [F.a, ["gemini-3.8-flash", "gemini-3.5-flash-lite"]]);
    const seen = await rows<{ provider: string; models: string[] | null }>(
      db,
      P.amir,
      "select provider, models from public.family_models()",
    );
    expect(seen).toEqual([
      { provider: "anthropic", models: null },
      { provider: "google", models: ["gemini-3.8-flash", "gemini-3.5-flash-lite"] },
    ]);
    expect(await rows(db, P.bea, "select provider, models from public.family_models()")).toEqual([
      { provider: "openai", models: null },
    ]);
  });

  it("cannot be changed from the browser", async () => {
    await expect(
      as(db, P.hasan, (tx) => tx.query(`select public.set_key_models($1, 'google', '{gemini-4-argon}')`, [F.a])),
    ).rejects.toThrow(/permission denied/);
    await expect(rows(db, null, "select * from public.family_models()")).rejects.toThrow(/permission denied/);
  });
});

describe("model choice", () => {
  it("people can remember their own last model", async () => {
    await as(db, P.amir, (tx) => tx.query("update profiles set last_model = 'claude-sonnet-5-5' where id = $1", [P.amir]));
    expect(await asServer("select last_model from profiles where id = $1", [P.amir])).toEqual([
      { last_model: "claude-sonnet-5-5" },
    ]);
  });

  it("but not anyone else's", async () => {
    await as(db, P.amir, (tx) => tx.query("update profiles set last_model = 'x' where id = $1", [P.hasan]));
    expect(await asServer("select last_model from profiles where id = $1", [P.hasan])).toEqual([{ last_model: null }]);
  });
});

describe("spending this month", () => {
  it("adds up only this month's usage", async () => {
    expect(await asServer("select public.month_spend($1)::text as s", [P.amir])).toEqual([{ s: "1.750000" }]);
    expect(await asServer("select public.month_spend($1)::text as s", [P.bea])).toEqual([{ s: "0" }]);
  });

  it("is not something the browser can ask for about anyone", async () => {
    await expect(rows(db, P.hasan, "select public.month_spend($1)", [P.amir])).rejects.toThrow(/permission denied/);
  });
});
