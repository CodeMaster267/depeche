import { expect, test } from "@playwright/test";
import { OWNER, admin, signInWithPassword, uniqueEmail } from "./helpers";

/** Personal instructions: written on the Memory page, private, and given to the model every time. */
test("personal instructions are saved, reach the model, and can be paused", async ({ page }) => {
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

  await page.goto("/memory");
  const form = page.getByTestId("personal-instructions");
  await form.getByLabel("About you").fill("I'm a nurse in Leeds.");
  await form.getByLabel("How should Depeche answer?").fill("Keep it short, in British English.");
  await form.getByRole("button", { name: "Save instructions" }).click();
  await expect(page.getByText("Saved. Depeche uses these in every chat from now on.")).toBeVisible();
  // Kept after a reload.
  await page.reload();
  await expect(form.getByLabel("About you")).toHaveValue("I'm a nurse in Leeds.");
  await expect(form.getByLabel("How should Depeche answer?")).toHaveValue("Keep it short, in British English.");

  // The model is given them.
  await page.goto("/");
  await page.getByRole("button", { name: /Change model/ }).click();
  await page.getByRole("dialog", { name: "Choose a model" }).getByRole("button", { name: /Gemini 3\.8 Flash/ }).click();
  await page.getByLabel("Message Depeche").fill("what are my instructions");
  await page.getByRole("button", { name: "Send" }).click();
  let reply = page.getByTestId("reply").last();
  await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
  await expect(reply).toContainText("About you: I'm a nurse in Leeds.");
  await expect(reply).toContainText("How to answer: Keep it short, in British English.");

  // Paused: kept on the page, but no longer sent.
  await page.goto("/memory");
  await form.getByRole("switch", { name: /Use in every chat/ }).uncheck();
  await form.getByRole("button", { name: "Save instructions" }).click();
  await expect(page.getByText("Saved. Depeche uses these in every chat from now on.")).toBeVisible();
  await page.reload();
  await expect(form.getByRole("switch", { name: /Use in every chat/ })).not.toBeChecked();
  await expect(form.getByLabel("About you")).toHaveValue("I'm a nurse in Leeds.");

  await page.goto("/");
  await page.getByLabel("Message Depeche").fill("what are my instructions");
  await page.getByRole("button", { name: "Send" }).click();
  reply = page.getByTestId("reply").last();
  await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
  await expect(reply).toContainText("No personal instructions.");
});
