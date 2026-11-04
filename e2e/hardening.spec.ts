import { expect, test, type Browser, type Page } from "@playwright/test";
import { OWNER, admin, signInWithPassword, uniqueEmail } from "./helpers";

/**
 * Hard spending caps, rate limits, signing out, backup admins, private chat titles, permanent
 * delete, and the privacy rules tried through the server's own endpoints across two families.
 */

async function freshPage(browser: Browser, contextOptions: object) {
  return (await browser.newContext(contextOptions)).newPage();
}

async function signInOwner(page: Page) {
  await signInWithPassword(page, OWNER.email, OWNER.password);
  await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
}

/** The owner's family gets a test Google key (accepted by the fake AI) if it has none. */
async function ensureGoogleKey(page: Page) {
  await page.goto("/family");
  const row = page.getByTestId("provider-google");
  await expect(row.getByText(/Not added|ends in/)).toBeVisible();
  if (await row.getByText("Not added").isVisible()) {
    await row.getByLabel("Google (Gemini) API key").fill("test-google-key-1234567890abcd");
    await row.getByRole("button", { name: "Save key" }).click();
    await expect(row.getByText(/ends in/)).toBeVisible();
  }
}

async function ownerFamily(): Promise<string> {
  const { data } = await admin().from("profiles").select("family_id").eq("is_app_owner", true).single();
  return data!.family_id as string;
}

/** A person made directly in the database, in the given family. */
async function person(family: string, first: string, opts: { cap?: number; role?: "admin" | "member" } = {}) {
  const db = admin();
  // A unique name too, since every browser's tests share the owner's family.
  const name = `${first} ${Math.random().toString(36).slice(2, 6)}`;
  const email = uniqueEmail(first.toLowerCase());
  const password = `${first.toLowerCase()}-password-123`;
  const { data } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  const { error } = await db.from("profiles").insert({
    id: data.user!.id,
    family_id: family,
    display_name: name,
    role: opts.role ?? "member",
    monthly_cap_usd: opts.cap ?? 10,
  });
  expect(error).toBeNull();
  return { id: data.user!.id, email, password, name };
}

/** A second family, with its own admin and the same (test) Google key copied in. */
async function otherFamily() {
  const db = admin();
  const { data: owner } = await db.from("profiles").select("id, family_id").eq("is_app_owner", true).single();
  const { data: fam } = await db
    .from("families")
    .insert({ name: `Friends ${Math.random().toString(36).slice(2, 7)}`, created_by: owner!.id })
    .select("id")
    .single();
  const boss = await person(fam!.id, "Bea", { role: "admin" });
  const { data: key } = await db.from("provider_keys").select("ciphertext, last4").eq("family_id", owner!.family_id).eq("provider", "google").single();
  await db.from("provider_keys").insert({ family_id: fam!.id, provider: "google", ciphertext: key!.ciphertext, last4: key!.last4, created_by: boss.id });
  return { id: fam!.id as string, admin: boss };
}

async function signIn(browser: Browser, contextOptions: object, who: { email: string; password: string; name: string }) {
  const page = await freshPage(browser, contextOptions);
  await signInWithPassword(page, who.email, who.password);
  await expect(page.getByRole("heading", { name: `Hi, ${who.name}.` })).toBeVisible();
  return page;
}

/** Sends a message straight to the chat endpoint and returns the status and the streamed events. */
async function chat(page: Page, body: Record<string, unknown>) {
  const res = await page.request.post("/api/chat", {
    data: { model: "gemini-3.8-flash", clientRequestId: crypto.randomUUID(), text: "Hello", ...body },
  });
  return { status: res.status(), text: await res.text() };
}

test.describe("spending caps are hard", () => {
  test("a reply is cut to fit what's left, and the next one is refused at the limit", async ({ page, browser, contextOptions }) => {
    await signInOwner(page);
    await ensureGoogleKey(page);
    // The limit leaves room for one reply whatever the size of the system prompt (which grows as
    // features are added), then earlier spending is recorded so less than any useful reply is left.
    const mina = await person(await ownerFamily(), "Mina", { cap: 0.05 });
    const member = await signIn(browser, contextOptions, mina);

    const first = await chat(member, { text: "What is a quadratic?" });
    expect(first.status).toBe(200);
    expect(first.text).toContain('"type":"done"');
    const spent = async () => {
      const { data } = await admin().from("usage_events").select("cost_usd").eq("owner_id", mina.id);
      return data!.reduce((n, r) => n + Number(r.cost_usd), 0);
    };
    const earlier = Math.max(0, Number((0.0495 - (await spent())).toFixed(6)));
    await admin().from("usage_events").insert({ owner_id: mina.id, provider: "google", model: "gemini-3.8-flash", input_tokens: 0, output_tokens: 0, cost_usd: earlier });
    const second = await chat(member, { text: "And another" });
    expect(second.status).toBe(402);
    expect(second.text).toMatch(/reached your \$0\.05 limit/);
    expect(await spent()).toBeLessThanOrEqual(0.05);
  });

  test("replies running at the same time can't add up past the limit", async ({ page, browser, contextOptions }) => {
    await signInOwner(page);
    await ensureGoogleKey(page);
    const zara = await person(await ownerFamily(), "Zara", { cap: 0.02 });
    const member = await signIn(browser, contextOptions, zara);
    const results = await Promise.all(Array.from({ length: 5 }, () => chat(member, { text: "Say this slowly please" })));
    const ok = results.filter((r) => r.status === 200).length;
    expect(ok).toBeGreaterThanOrEqual(1);
    expect(ok).toBeLessThan(5);
    for (const r of results.filter((r) => r.status !== 200)) expect(r.text).toMatch(/limit|Too many replies/);
    const { data } = await admin().from("usage_events").select("cost_usd").eq("owner_id", zara.id);
    expect(data!.reduce((n, r) => n + Number(r.cost_usd), 0)).toBeLessThanOrEqual(0.02);
  });
});

test.describe("rate limits", () => {
  test("after ten wrong passwords an account is held back, even with the right one", async ({ page }) => {
    const omar = await person(await ownerFamily(), "Omar");
    for (let i = 0; i < 10; i++) {
      await signInWithPassword(page, omar.email, "not-the-password");
      await expect(page.locator("p[role=alert]")).toHaveText(/isn't right/);
    }
    await signInWithPassword(page, omar.email, omar.password);
    await expect(page.locator("p[role=alert]")).toHaveText(/Too many tries/);
  });
});

test.describe("accounts", () => {
  test("sign out everywhere ends every session; an admin can sign a member out too", async ({ page, browser, contextOptions }) => {
    await signInOwner(page);
    const leo = await person(await ownerFamily(), "Leo");
    const phone = await signIn(browser, contextOptions, leo);
    const laptop = await signIn(browser, contextOptions, leo);

    await laptop.goto("/account");
    await laptop.getByRole("button", { name: "Sign out everywhere" }).click();
    await expect(laptop).toHaveURL(/\/sign-in/);
    await phone.goto("/account");
    await expect(phone).toHaveURL(/\/sign-in/);

    // Signed in again, then the admin signs Leo out.
    const again = await signIn(browser, contextOptions, leo);
    await page.goto("/family");
    const row = page.getByTestId("member-row").filter({ hasText: leo.name });
    await row.getByRole("button", { name: new RegExp(leo.name) }).click();
    await row.getByRole("button", { name: "Sign them out everywhere" }).click();
    await expect(row.getByText("Signed out on all their devices.")).toBeVisible();
    await again.goto("/");
    await expect(again).toHaveURL(/\/sign-in/);
    await expect(page.getByTestId("admin-log")).toContainText(`You signed ${leo.name} out on all devices`);
  });

  test("an admin makes a backup admin, who then has the Family page", async ({ page, browser, contextOptions }) => {
    // A family of its own, so other tests' admins don't get in the way.
    const fam = await otherFamily();
    const sam = await person(fam.id, "Sam");
    const bea = await signIn(browser, contextOptions, fam.admin);
    await bea.goto("/family");
    const row = bea.getByTestId("member-row").filter({ hasText: sam.name });
    await row.getByRole("button", { name: new RegExp(sam.name) }).click();
    await row.getByRole("button", { name: "Make backup admin" }).click();
    await expect(row.getByText("They're now a backup admin.")).toBeVisible();

    const backup = await signIn(browser, contextOptions, sam);
    await backup.goto("/family");
    await expect(backup.getByRole("heading", { level: 1 })).toContainText("Friends");
    await expect(backup.getByTestId("admin-log")).toContainText(`${fam.admin.name} made you a backup admin`);
    void page;
  });
});

test.describe("privacy", () => {
  test("chat titles stay private until the member shares them", async ({ page, browser, contextOptions }) => {
    await signInOwner(page);
    await ensureGoogleKey(page);
    const ivy = await person(await ownerFamily(), "Ivy");
    const member = await signIn(browser, contextOptions, ivy);
    expect((await chat(member, { text: "Secret birthday plans" })).status).toBe(200);

    const ivyRow = async () => {
      await page.goto("/family");
      const row = page.getByTestId("member-row").filter({ hasText: ivy.name });
      await row.getByRole("button", { name: new RegExp(ivy.name) }).click();
      return row;
    };
    let row = await ivyRow();
    await expect(row.getByTestId("titles-note")).toHaveText("They keep their chat titles private.");
    await expect(page.getByText("Secret birthday plans")).toHaveCount(0);

    await member.goto("/account");
    const toggle = member.getByRole("switch", { name: /Show my chat titles/ });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect.poll(async () => (await admin().from("profiles").select("share_titles").eq("id", ivy.id).single()).data?.share_titles).toBe(true);

    row = await ivyRow();
    await expect(row.getByTestId("shared-titles")).toContainText("Secret birthday plans");
  });

  test("a member can permanently delete all their chats and memories", async ({ page, browser, contextOptions }) => {
    await signInOwner(page);
    await ensureGoogleKey(page);
    const kai = await person(await ownerFamily(), "Kai");
    const member = await signIn(browser, contextOptions, kai);
    expect((await chat(member, { text: "Something to forget" })).status).toBe(200);
    await admin().from("memories").insert({ owner_id: kai.id, content: "Kai likes trains", status: "active" });

    await member.goto("/account");
    await member.getByRole("button", { name: "Delete all my chats and memories" }).click();
    await expect(member.getByText("Type delete to confirm.")).toBeVisible();
    await member.getByLabel("Type delete to confirm").fill("delete");
    await member.getByRole("button", { name: "Delete all my chats and memories" }).click();
    await expect(member.getByText("All your chats, memories and personal instructions are deleted.")).toBeVisible();

    const db = admin();
    expect((await db.from("chats").select("id").eq("owner_id", kai.id)).data).toEqual([]);
    expect((await db.from("messages").select("id").eq("owner_id", kai.id)).data).toEqual([]);
    expect((await db.from("memories").select("id").eq("owner_id", kai.id)).data).toEqual([]);
  });

  test("the sign-in page says who sees your messages", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page.getByTestId("who-sees")).toHaveText(/Only you can read your chats/);
  });
});

test.describe("across families, through the server's own endpoints", () => {
  test("nobody reaches another family's chats, people or log", async ({ page, browser, contextOptions }) => {
    await signInOwner(page);
    await ensureGoogleKey(page);
    const family = await ownerFamily();
    const ana = await person(family, "Ana");
    const anaPage = await signIn(browser, contextOptions, ana);
    const sent = await chat(anaPage, { text: "Ana's private question" });
    expect(sent.status).toBe(200);
    const start = JSON.parse(sent.text.split("\n")[0]) as { chatId: string; userMessageId: string };
    await admin().from("profiles").update({ share_titles: true }).eq("id", ana.id);

    const fam = await otherFamily();
    const bea = await signIn(browser, contextOptions, fam.admin);

    // The chat endpoint: posting into, or answering again, another person's chat.
    expect((await chat(bea, { chatId: start.chatId })).status).toBe(404);
    expect((await chat(bea, { chatId: start.chatId, regenerate: start.userMessageId, text: "" })).status).toBe(404);
    // Even the owner, admin of Ana's own family, can't write into her chat.
    expect((await chat(page, { chatId: start.chatId })).status).toBe(404);

    // Pages.
    await bea.goto(`/c/${start.chatId}`);
    await expect(bea.getByText(/could not be found|404/i).first()).toBeVisible();
    await bea.goto("/family");
    await expect(bea.getByText(ana.name)).toHaveCount(0);
    await expect(bea.getByText("Ana's private question")).toHaveCount(0);
    await expect(bea.getByRole("main")).not.toContainText("Hasan");

    // Ana's messages never reach the database through Bea's own session either.
    const { createClient } = await import("@supabase/supabase-js");
    const asBea = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { persistSession: false },
    });
    await asBea.auth.signInWithPassword({ email: fam.admin.email, password: fam.admin.password });
    for (const table of ["chats", "messages", "memories", "usage_events", "admin_log", "spend_holds"]) {
      const { data } = await asBea.from(table).select("*").eq(table === "admin_log" ? "subject_id" : "owner_id", ana.id);
      expect(data ?? [], table).toEqual([]);
    }
    const { error } = await asBea.rpc("sign_out_everywhere", { p_actor: fam.admin.id, p_person: ana.id });
    expect(error?.message).toMatch(/permission denied/);
  });
});
