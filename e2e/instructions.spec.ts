import { expect, test, type Page } from "@playwright/test";
import { OWNER, admin, signInWithPassword, uniqueEmail } from "./helpers";

/** Personal instructions: written on the Memory page, private, and given to the model every time. */
test("personal instructions are saved, reach the model, and can be paused", async ({ page }) => {
  // Many steps (sign in, save twice, two replies): more than the default 30 seconds on a slow runner.
  test.slow();
  const db = admin();
  // The family needs a key for a model; the owner's test key is used if it's already there.
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  const { data: key } = await db.from("provider_keys").select("id").eq("family_id", owner!.family_id).eq("provider", "google").maybeSingle();
  if (!key) {
    await signInWithPassword(page, OWNER.email, OWNER.password);
    await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
    await page.goto("/family");
    const row = page.getByTestId("provider-google");
    await expect(row.getByText(/Not added|ends in/)).toBeVisible();
    if (await row.getByText("Not added").isVisible()) {
      await row.getByLabel("Google (Gemini) API key").fill("test-google-key-1234567890abcd");
      await row.getByRole("button", { name: "Save key" }).click();
      await expect(row.getByText(/ends in/)).toBeVisible();
    }
    await page.context().clearCookies();
  }

  const email = uniqueEmail("tailor");
  const { data: user } = await db.auth.admin.createUser({ email, password: "member-password-123", email_confirm: true });
  await db.from("profiles").insert({ id: user.user!.id, family_id: owner!.family_id, display_name: "Tara" });

  await signInWithPassword(page, email, "member-password-123");
  await expect(page.getByRole("heading", { name: "Hi, Tara." })).toBeVisible();

  await open(page, "/memory");
  const form = page.getByTestId("personal-instructions");
  await form.getByLabel("About you").fill("I'm a nurse in Leeds.");
  await form.getByLabel("How should Depeche answer?").fill("Keep it short, in British English.");
  await expect(form.getByLabel("About you")).toHaveValue("I'm a nurse in Leeds.");
  await form.getByRole("button", { name: "Save instructions" }).click();
  await expect(page.getByText("Saved. Depeche uses these in every chat from now on.")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await db.from("personal_instructions").select("about_me").eq("owner_id", user.user!.id).maybeSingle()).data?.about_me).toBe("I'm a nurse in Leeds.");
  // Kept after a reload.
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(form.getByLabel("About you")).toHaveValue("I'm a nurse in Leeds.");
  await expect(form.getByLabel("How should Depeche answer?")).toHaveValue("Keep it short, in British English.");

  // The model is given them.
  await open(page, "/");
  const picker = page.getByRole("dialog", { name: "Choose a model" });
  await expect(async () => {
    if (!(await picker.isVisible())) await page.getByRole("button", { name: /Change model/ }).click();
    await expect(picker).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await picker.getByRole("button", { name: /Gemini 3\.8 Flash/ }).click();
  await expect(picker).toHaveCount(0);
  await ask(page, "what are my instructions");
  let reply = page.getByTestId("reply").last();
  // Waits for the reply itself: before it appears, "not busy" would pass straight away.
  await expect(reply).toContainText("About you: I'm a nurse in Leeds.", { timeout: 20_000 });
  await expect(reply).toContainText("How to answer: Keep it short, in British English.");

  // Paused: kept on the page, but no longer sent.
  await open(page, "/memory");
  const toggle = form.getByRole("switch", { name: /Use in every chat/ });
  await expect(async () => {
    await toggle.uncheck();
    await expect(toggle).not.toBeChecked({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await form.getByRole("button", { name: "Save instructions" }).click();
  await expect(page.getByText("Saved. Depeche uses these in every chat from now on.")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await db.from("personal_instructions").select("enabled").eq("owner_id", user.user!.id).maybeSingle()).data?.enabled).toBe(false);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(form.getByRole("switch", { name: /Use in every chat/ })).not.toBeChecked();
  await expect(form.getByLabel("About you")).toHaveValue("I'm a nurse in Leeds.");

  await open(page, "/");
  await ask(page, "what are my instructions");
  reply = page.getByTestId("reply").last();
  await expect(reply).toContainText("No personal instructions.", { timeout: 20_000 });
  await expect(reply).not.toContainText("nurse in Leeds");
});

/**
 * Types and sends a message. An empty composer shows the voice button instead of Send. Text typed
 * before the page has finished loading can be kept on screen but missed by React, and typing the
 * same text again then changes nothing React notices, so it clears the box before each try.
 */
async function ask(page: Page, text: string) {
  const box = page.getByLabel("Message Depeche");
  const send = page.getByRole("button", { name: "Send" });
  await expect(async () => {
    await box.fill("");
    await box.fill(text);
    await expect(send).toBeEnabled({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await send.click();
}

/** Opens a page and waits for its scripts, so taps and typing reach the app rather than bare HTML. */
async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}
