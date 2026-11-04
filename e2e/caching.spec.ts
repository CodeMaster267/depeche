import { expect, test } from "@playwright/test";
import { OWNER, admin, signInWithPassword } from "./helpers";

test("an answer that reused cached input says so and costs less", async ({ page }) => {
  await signInWithPassword(page, OWNER.email, OWNER.password);
  await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
  // The family needs a key for a model to answer; a test Google key is added if there's none yet.
  await page.goto("/family");
  const row = page.getByTestId("provider-google");
  await expect(row.getByText(/Not added|ends in/)).toBeVisible();
  if (await row.getByText("Not added").isVisible()) {
    await row.getByLabel("Google (Gemini) API key").fill("test-google-key-1234567890abcd");
    await row.getByRole("button", { name: "Save key" }).click();
    await expect(row.getByText(/ends in/)).toBeVisible();
  }
  await page.goto("/");
  const question = `A cached question ${Date.now()}`;
  await page.getByLabel("Message Depeche").fill(question);
  await page.getByRole("button", { name: "Send" }).click();
  const reply = page.getByTestId("reply").last();
  await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });

  // The chat's address changes once the answer is saved; a tap during that re-render can be lost
  // (seen on Safari), so tap again until the details open.
  await expect(page).toHaveURL(/\/c\//);
  const details = page.getByTestId("cost-details");
  await expect(async () => {
    if (!(await details.isVisible())) await reply.getByTestId("message-cost").click();
    await expect(details).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await expect(details).toContainText("1,200 tokens");
  await expect(details.getByTestId("cost-cached")).toContainText("1,000 tokens");
  await expect(details).toContainText("read back from the provider's cache");

  // Saved with the answer, and priced at the cache rate rather than in full.
  const chatId = new URL(page.url()).pathname.split("/").pop()!;
  const { data: saved } = await admin().from("messages").select("content, model").eq("chat_id", chatId).eq("role", "assistant").single();
  expect(saved!.content.usage).toEqual({ input: 1200, output: 400, cached: 1000 });
  const { findModel, estimateCost } = await import("../lib/ai/models");
  const model = findModel(saved!.model)!;
  expect(saved!.content.cost).toBeCloseTo(estimateCost(model, 1200, 400, { read: 1000 }), 9);
  if (model.price.cache && model.price.cache.read < 1) expect(saved!.content.cost).toBeLessThan(estimateCost(model, 1200, 400));
});
