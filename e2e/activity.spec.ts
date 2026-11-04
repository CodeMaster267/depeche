import { expect, test, type Page } from "@playwright/test";
import { OWNER, admin, noSidewaysScroll, signInWithPassword, watchErrors } from "./helpers";

/**
 * What a reply did besides writing, shown as short lines, and each reply's raw Markdown. The
 * stand-in AI (DEPECHE_FAKE_AI) reasons before answering when a message says "think" (slowly with
 * "think hard"), as models that share their reasoning do.
 */

async function start(page: Page) {
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
  await page.goto("/");
  await page.getByRole("button", { name: /Change model/ }).click();
  await page.getByRole("dialog", { name: "Choose a model" }).getByRole("button", { name: /Gemini 3\.8 Flash/ }).click();
  await expect(page.getByRole("button", { name: /Model: Gemini 3\.8 Flash/ })).toBeVisible();
}

async function send(page: Page, text: string) {
  await page.getByLabel("Message Depeche").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

test("a reply's reasoning is one collapsed line that opens to show it", async ({ page }) => {
  const errors = watchErrors(page);
  await start(page);
  await send(page, `Please think hard about quadratics. ${Date.now()}`);
  const reply = page.getByTestId("reply").last();

  // While it reasons, the line says so and counts up.
  const thought = reply.getByTestId("thought");
  await expect(thought.getByRole("button", { name: /^Thinking/ })).toBeVisible();
  await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 20_000 });

  // Afterwards it says how long, and the reasoning stays hidden until asked for.
  const toggle = thought.getByRole("button", { name: /^Thought for (\d+s|a moment)$/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(reply.getByTestId("reasoning")).toHaveCount(0);
  await expect(reply.getByRole("heading", { name: "The formula" })).toBeVisible();
  // The reasoning never leaks into the reply itself.
  await expect(reply.locator(".md").first()).not.toContainText("Weighing the approach");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(reply.getByTestId("reasoning")).toContainText("Weighing the approach");
  await expect(reply.getByTestId("reasoning").locator("strong").first()).toHaveText("Weighing the approach");
  await noSidewaysScroll(page);

  // It's saved with the reply, with how long it took.
  await page.reload();
  const saved = page.getByTestId("reply").last();
  await expect(saved.getByTestId("thought").getByRole("button", { name: /^Thought for/ })).toBeVisible();
  const { data: msg } = await admin()
    .from("messages")
    .select("content")
    .eq("role", "assistant")
    .eq("chat_id", page.url().split("/c/")[1])
    .single<{ content: { text: string; reasoning: string; thoughtMs: number } }>();
  expect(msg!.content.reasoning).toContain("Checking the roots");
  expect(msg!.content.text).not.toContain("Checking the roots");
  expect(msg!.content.thoughtMs).toBeGreaterThan(500);
  expect(errors.filter((e) => !/_rsc=.*access control checks/is.test(e))).toEqual([]);
});

test("a reply without reasoning or searching has no extra lines", async ({ page }) => {
  await start(page);
  await page.getByRole("button", { name: "Search the web" }).click();
  await send(page, `How do quadratics work? ${Date.now()}`);
  const reply = page.getByTestId("reply").last();
  await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
  await expect(reply.getByTestId("activity")).toHaveCount(0);
});

test("view source shows a reply's raw Markdown, with copy", async ({ page, context, browserName }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await start(page);
  await send(page, `Quadratics, please. ${Date.now()}`);
  const reply = page.getByTestId("reply").last();
  await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });

  const view = reply.getByRole("button", { name: "View Markdown source" });
  await expect(reply.getByTestId("reply-source")).toHaveCount(0);
  await view.click();
  const source = reply.getByTestId("reply-source");
  // The Markdown as written: headings, maths and fences, not their rendering.
  await expect(source.locator("pre")).toContainText("## The formula");
  await expect(source.locator("pre")).toContainText("x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}");
  await expect(source.locator("pre")).toContainText("```mermaid");
  await noSidewaysScroll(page);

  await source.getByRole("button", { name: "Copy source" }).click();
  await expect(source.getByRole("button", { name: "Copied" })).toBeVisible();
  if (browserName === "chromium") {
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("## The formula");
  }

  await reply.getByRole("button", { name: "Hide Markdown source" }).click();
  await expect(reply.getByTestId("reply-source")).toHaveCount(0);
});
