import { expect, test, type Page } from "@playwright/test";
import { OWNER, admin, noSidewaysScroll, signInWithPassword, uniqueEmail, watchErrors } from "./helpers";

/**
 * Comparing models: one question to two models side by side, swipe or tap between the answers,
 * pick one to continue from. Each answer is its own request with its own spending hold, so both
 * are counted toward the monthly limit.
 */

async function signInOwner(page: Page) {
  await signInWithPassword(page, OWNER.email, OWNER.password);
  await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
}

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

/**
 * A person of their own in the owner's family: each person may have only three replies being
 * written at once, and every browser runs this test side by side.
 */
async function member(page: Page, cap = 10) {
  await signInOwner(page);
  await ensureGoogleKey(page);
  const db = admin();
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  const name = `Duet${Math.random().toString(36).slice(2, 6)}`;
  const email = uniqueEmail("duet");
  const password = "duet-password-123";
  const { data } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  const { error } = await db
    .from("profiles")
    .insert({ id: data.user!.id, family_id: owner!.family_id, display_name: name, role: "member", monthly_cap_usd: cap });
  expect(error).toBeNull();
  await page.context().clearCookies();
  await signInWithPassword(page, email, password);
  await expect(page.getByRole("heading", { name: `Hi, ${name}.` })).toBeVisible();
}

/** In the picker's compare mode, tick exactly these models, in this order. */
async function compare(page: Page, names: RegExp[]) {
  await page.getByRole("button", { name: /Change model/ }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a model" });
  await dialog.getByRole("button", { name: "Compare", exact: true }).click();
  // Untick whatever starts ticked, then tick in order.
  for (const row of await dialog.locator("li > button[aria-pressed=true]").all()) await row.click();
  for (const name of names) await dialog.getByRole("button", { name }).click();
  await dialog.getByRole("button", { name: `Compare ${names.length} models` }).click();
  await expect(dialog).toHaveCount(0);
}

test("two models answer side by side, and the chat continues from the one picked", async ({ page }, info) => {
  const errors = watchErrors(page);
  await member(page);
  await compare(page, [/^Gemini 3\.8 Flash/, /^Flash-Lite|Gemini 3\.5 Flash-Lite/]);
  await expect(page.getByRole("button", { name: "Comparing 2 models. Change models" })).toBeVisible();
  await expect(page.getByTestId("compare-chip")).toHaveText(/Next message goes to Gemini 3\.8 Flash, Flash-Lite/);

  const question = `Compare these ${info.project.name} ${Date.now()}`;
  await page.getByLabel("Message Depeche").fill(question);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);
  const chatId = page.url().split("/c/")[1];

  const group = page.getByTestId("compare");
  const panes = group.getByTestId("compare-pane");
  await expect(panes).toHaveCount(2);
  for (const pane of await panes.all()) {
    await expect(pane.getByTestId("reply")).not.toHaveAttribute("aria-busy", "true", { timeout: 20_000 });
  }
  await expect(panes.nth(0).getByRole("heading", { name: "Gemini 3.8 Flash" })).toBeVisible();
  await expect(panes.nth(0)).toHaveAttribute("data-chosen", "true");
  // Comparing is for one message: the header goes back to one model.
  await expect(page.getByTestId("compare-chip")).toHaveCount(0);
  // Each answer shows what it cost.
  await expect(panes.nth(1).getByText(/^Flash-Lite · \$/)).toBeVisible();
  await noSidewaysScroll(page);

  // Jump to the second answer with its tab; on a phone it slides into view.
  await group.getByRole("tab", { name: /Flash-Lite/ }).click();
  await expect(group.getByRole("tab", { name: /Flash-Lite/ })).toHaveAttribute("aria-selected", "true");
  // The answer slides sideways into view (answers are long, so only its width is checked).
  await expect
    .poll(async () => {
      const box = await panes.nth(1).boundingBox();
      const width = page.viewportSize()!.width;
      return box ? box.x >= -1 && box.x + box.width <= width + 1 : false;
    })
    .toBe(true);
  await panes.nth(1).getByRole("button", { name: "Continue with this" }).click();
  await expect(panes.nth(1)).toHaveAttribute("data-chosen", "true");
  await expect(page.getByRole("button", { name: "Model: Gemini 3.5 Flash-Lite. Change model" })).toBeVisible();

  // The follow-up goes after the picked answer, to the picked model.
  await page.getByLabel("Message Depeche").fill(`And then? ${Date.now()}`);
  await page.getByRole("button", { name: "Send" }).click();
  const last = page.getByTestId("reply").last();
  await expect(last).not.toHaveAttribute("aria-busy", "true", { timeout: 20_000 });
  await expect(last.getByText(/^Flash-Lite · \$/)).toBeVisible();

  const db = admin();
  const { data: rows } = await db
    .from("messages")
    .select("id, parent_id, role, model, content")
    .eq("chat_id", chatId)
    .order("created_at");
  const replies = (rows ?? []).filter((m) => m.role === "assistant" && m.content.compare);
  expect(replies.map((r) => r.model).sort()).toEqual(["gemini-3.5-flash-lite", "gemini-3.8-flash"]);
  const picked = replies.find((r) => r.model === "gemini-3.5-flash-lite")!;
  const followUp = (rows ?? []).filter((m) => m.role === "user").at(-1)!;
  expect(followUp.parent_id).toBe(picked.id);
  // Both answers were charged against the monthly limit, one usage record each.
  const { data: usage } = await db.from("usage_events").select("message_id").in("message_id", replies.map((r) => r.id));
  expect(usage).toHaveLength(2);

  // After a reload the comparison is still there, with the picked answer marked.
  await page.reload();
  await expect(page.getByTestId("compare-pane")).toHaveCount(2);
  await expect(page.getByTestId("compare-pane").nth(1)).toHaveAttribute("data-chosen", "true");
  await expect(page.getByTestId("compare-pane").nth(1).getByText("Picked")).toBeVisible();
  await noSidewaysScroll(page);
  expect(errors.filter((e) => !/_rsc=.*access control checks/.test(e))).toEqual([]);
});

test("each model's answer counts toward the monthly limit", async ({ page }) => {
  // A tiny limit: the first answer's hold takes all of it, so the second model is refused.
  await member(page, 0.2);
  // Without web search, so the hold is just the reply: about $0.49 at most, granted $0.20.
  const globe = page.getByRole("button", { name: "Search the web" });
  if ((await globe.getAttribute("aria-pressed")) === "true") await globe.click();
  await compare(page, [/^Gemini 3\.8 Flash/, /^Flash-Lite|Gemini 3\.5 Flash-Lite/]);
  await page.getByLabel("Message Depeche").fill(`Over the limit ${Date.now()}`);
  await page.getByRole("button", { name: "Send" }).click();
  const panes = page.getByTestId("compare-pane");
  await expect(panes).toHaveCount(2);
  await expect(panes.nth(1).getByRole("alert")).toHaveText(/reached your \$0\.20 limit/, { timeout: 20_000 });
  await expect(panes.nth(0).getByTestId("reply")).not.toHaveAttribute("aria-busy", "true", { timeout: 20_000 });
});
