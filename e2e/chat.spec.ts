import { expect, test, type Page } from "@playwright/test";
import { OWNER, admin, menuLink, noSidewaysScroll, signInWithPassword, uniqueEmail, watchErrors } from "./helpers";

/**
 * Chatting. Replies come from the built-in stand-in (DEPECHE_FAKE_AI), which streams a fixed reply
 * with a table, maths, code, a diagram and a source, so every kind of rendering is exercised.
 */

async function signInOwner(page: Page) {
  await signInWithPassword(page, OWNER.email, OWNER.password);
  await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
}

/** The family needs a Google key before Gemini models appear. Test keys start with "test-". */
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

async function pickModel(page: Page, name: string) {
  await page.getByRole("button", { name: /Change model/ }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a model" });
  await dialog.getByRole("button", { name: new RegExp(name) }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: new RegExp(`Model: ${name}`) })).toBeVisible();
}

async function send(page: Page, text: string) {
  await page.getByLabel("Message Depeche").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

test.describe("family keys", () => {
  test("a wrong key is refused and a good key is saved, showing only its last four characters", async ({ page }, info) => {
    test.skip(info.project.name !== "chrome-desktop", "changes shared family keys, so it runs once");
    await signInOwner(page);
    await page.goto("/family");
    const row = page.getByTestId("provider-openai");
    if (await row.getByRole("button", { name: "Remove" }).isVisible()) await row.getByRole("button", { name: "Remove" }).click();
    await expect(row.getByText("Not added")).toBeVisible();

    await row.getByLabel("OpenAI (GPT) API key").fill("sk-not-a-real-key-000000000000");
    await row.getByRole("button", { name: "Save key" }).click();
    await expect(row.locator("p[role=alert]")).toHaveText(/didn't accept that key/);

    await row.getByLabel("OpenAI (GPT) API key").fill("test-openai-key-0000000000wxyz");
    await row.getByRole("button", { name: "Save key" }).click();
    await expect(row.getByText(/ends in/)).toBeVisible();
    await expect(row.getByText("wxyz")).toBeVisible();
    // The key itself is never sent back to the page.
    expect(await page.content()).not.toContain("test-openai-key");

    await row.getByRole("button", { name: "Remove" }).click();
    await expect(row.getByText("Not added")).toBeVisible();
  });

  test("models a key can't use are hidden", async ({ page }, info) => {
    test.skip(info.project.name !== "chrome-desktop", "changes shared family keys, so it runs once");
    await signInOwner(page);
    await ensureGoogleKey(page);
    const row = page.getByTestId("provider-google");
    const replaceWith = async (key: string) => {
      await row.getByRole("button", { name: "Replace" }).click();
      await row.getByLabel("Google (Gemini) API key").fill(key);
      await row.getByRole("button", { name: "Save key" }).click();
      await expect(row.getByText(/ends in/)).toBeVisible();
    };

    // A free-tier key can't use Gemini 4 Argon, so nobody is offered it.
    await replaceWith("test-google-free-key-000000free");
    await expect(row.getByTestId("key-models")).toHaveText("Can use Gemini 3.8 Flash, Flash-Lite");
    await page.goto("/");
    await page.getByRole("button", { name: /Change model/ }).click();
    const dialog = page.getByRole("dialog", { name: "Choose a model" });
    await expect(dialog.getByRole("button", { name: /Gemini 3\.8 Flash/ })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Argon/ })).toHaveCount(0);

    // A full key brings it back.
    await page.goto("/family");
    await replaceWith("test-google-key-1234567890abcd");
    await expect(row.getByTestId("key-models")).toHaveText("Can use Gemini 4 Argon, Gemini 3.8 Flash, Flash-Lite");
  });
});

test.describe("chatting", () => {
  test("a reply streams in and renders tables, maths, code, diagrams and sources", async ({ page }) => {
    const errors = watchErrors(page);
    await signInOwner(page);
    await ensureGoogleKey(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
    await pickModel(page, "Gemini 3.8 Flash");

    const question = `How do I solve a quadratic? ${Date.now()}`;
    await send(page, question);
    await expect(page.getByTestId("user-message").last()).toHaveText(question);
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);

    const reply = page.getByTestId("reply").last();
    await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
    await expect(reply.getByRole("heading", { name: "The formula" })).toBeVisible();
    await expect(reply.locator(".katex-display")).toHaveCount(1);
    await expect(reply.locator(".katex").first()).toBeVisible();
    await expect(reply.getByRole("table")).toBeVisible();
    await expect(reply.getByRole("cell", { name: "Discriminant" })).toBeVisible();
    await expect(reply.locator(".md-code-bar").getByText("python")).toBeVisible();
    await expect(reply.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
    await expect(reply.locator(".hljs-keyword").first()).toHaveText("import");
    await expect(reply.locator(".md-diagram-svg svg")).toBeVisible({ timeout: 15_000 });
    await expect(reply.getByRole("heading", { name: "Sources" })).toBeVisible();
    await expect(reply.getByRole("link", { name: "Quadratic formula" })).toHaveAttribute("target", "_blank");
    await expect(reply.getByText(/^Gemini 3\.8 Flash · \$/)).toBeVisible();
    await noSidewaysScroll(page);

    // The chat is saved: it is in the list and comes back after a reload.
    const chatUrl = page.url();
    await page.reload();
    await expect(page.getByTestId("user-message").last()).toHaveText(question);
    await expect(page.getByTestId("reply").last().getByRole("table")).toBeVisible();
    await expect(await menuLink(page, question)).toBeVisible();
    expect(page.url()).toBe(chatUrl);
    // Safari reports link prefetches it cancels on reload; those aren't errors in the page.
    expect(errors.filter((e) => !/_rsc=.*access control checks/.test(e))).toEqual([]);
  });

  test("a reply can be stopped part way, and what was written is kept", async ({ page }) => {
    await signInOwner(page);
    await ensureGoogleKey(page);
    await page.goto("/");
    await pickModel(page, "Gemini 3.8 Flash");
    await send(page, "Please answer slowly");
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(page.getByTestId("reply").last()).toContainText("worked answer");
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByTestId("reply").last().getByText("Stopped.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Voice chat" })).toBeVisible();
    // Reloading shows the saved, partial reply.
    await page.waitForTimeout(1500);
    await page.reload();
    await expect(page.getByTestId("reply").last()).toContainText("worked answer");
    await expect(page.getByTestId("reply").last().getByText("Stopped.")).toBeVisible();
  });

  test("try again writes a new reply and keeps the conversation", async ({ page }) => {
    await signInOwner(page);
    await ensureGoogleKey(page);
    await page.goto("/");
    await pickModel(page, "Gemini 3.8 Flash");
    await send(page, "First question");
    await expect(page.getByTestId("reply").last()).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("reply").last()).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
    await expect(page.getByTestId("reply")).toHaveCount(1);
    await expect(page.getByTestId("user-message")).toHaveCount(1);
  });
});

test.describe("busy models", () => {
  test("a busy model is retried, then a lighter one answers and says so", async ({ page }) => {
    await signInOwner(page);
    await ensureGoogleKey(page);
    await page.goto("/");
    await pickModel(page, "Gemini 3.8 Flash");
    await send(page, "Are you busy?");
    const reply = page.getByTestId("reply").last();
    await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 20_000 });
    await expect(reply).toContainText("worked answer");
    await expect(reply.getByText("Gemini 3.8 Flash was busy, so Gemini 3.5 Flash-Lite answered instead.")).toBeVisible();
    await expect(reply.getByText(/^Flash-Lite · \$/)).toBeVisible();
  });
});

test.describe("privacy and limits", () => {
  test("a member can't open someone else's chat, and their limit stops them", async ({ page, browser, contextOptions }) => {
    // The owner starts a chat.
    await signInOwner(page);
    await ensureGoogleKey(page);
    await page.goto("/");
    await pickModel(page, "Gemini 3.8 Flash");
    await send(page, "Owner's private question");
    await expect(page).toHaveURL(/\/c\//);
    const ownerChat = page.url();

    // A member of the same family, made directly in the database, with a $0 limit.
    const db = admin();
    const email = uniqueEmail("member");
    const { data: user } = await db.auth.admin.createUser({ email, password: "member-password-123", email_confirm: true });
    const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
    await db.from("profiles").insert({ id: user.user!.id, family_id: owner!.family_id, display_name: "Mina", monthly_cap_usd: 0 });

    const member = await (await browser.newContext(contextOptions)).newPage();
    await signInWithPassword(member, email, "member-password-123");
    await expect(member.getByRole("heading", { name: "Hi, Mina." })).toBeVisible();
    await member.goto(ownerChat);
    await expect(member.getByText(/could not be found|404/i).first()).toBeVisible();

    // Members see the family's models but can't spend past their limit.
    await member.goto("/");
    await send(member, "Hello");
    await expect(member.locator("p[role=alert]")).toHaveText(/reached your \$0\.00 limit/);
    await expect(member.getByLabel("Message Depeche")).toHaveValue("Hello");
    await expect(member.getByTestId("user-message")).toHaveCount(0);
  });
});
