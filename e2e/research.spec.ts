import { expect, test, type Page } from "@playwright/test";
import { OWNER, noSidewaysScroll, signInWithPassword, watchErrors } from "./helpers";

/**
 * Deep research. The stand-in AI (DEPECHE_FAKE_AI) gets a fixed three-question plan, searches the
 * web for each question when the request says "latest", and writes its usual reply as the report.
 * "slowly" slows it down (to test stopping); "handover" makes every step hand over to the next as a
 * new request, as long research does on Vercel.
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

async function research(page: Page, text: string) {
  const toggle = page.getByRole("button", { name: "Deep research" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByPlaceholder("What to research?")).toBeVisible();
  await page.getByLabel("Message Depeche").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  // Research is for one message: the switch turns itself off.
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
}

test.describe("deep research", () => {
  // A run takes several steps, each a separate request, so these take longer than most tests.
  test.setTimeout(90_000);

  test("plans, searches each question across steps, and writes a cited report", async ({ page }) => {
    await start(page);
    const errors = watchErrors(page);
    await research(page, `The latest on heat pumps, slowly, handover ${Date.now()}`);

    const card = page.getByTestId("research");
    await expect(card).toBeVisible();
    await expect(card.getByText("Deep research", { exact: true })).toBeVisible();
    await expect(card.getByRole("listitem")).toHaveCount(3, { timeout: 20_000 });
    await noSidewaysScroll(page);
    // While it runs, the chat waits: the send button is a stop button.
    await expect(page.getByRole("button", { name: "Stop", exact: true }).first()).toBeVisible();

    // The report arrives as a reply, with the sources from every round of searching.
    const reply = page.getByTestId("reply").last();
    await expect(reply).toBeVisible({ timeout: 60_000 });
    await expect(card).toHaveCount(0);
    await expect(reply.getByTestId("sources").getByRole("button", { name: /3 sources/ })).toBeVisible();
    await expect(reply.getByText(/\$\d/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    // Safari can report a page prefetch that a navigation cancelled (see watchErrors); that isn't
    // a fault in Depeche. Checked before reloading for the same reason.
    expect(errors.filter((e) => !/_rsc=.* due to access control checks/.test(e))).toEqual([]);

    // It's an ordinary reply in the chat, still there after a reload.
    await page.reload();
    await expect(page.getByTestId("reply").last().getByTestId("sources")).toBeVisible();
    await expect(page.getByTestId("research")).toHaveCount(0);
  });

  test("can be stopped, and the chat can carry on", async ({ page }) => {
    await start(page);
    await research(page, `The latest, slowly, on e-bikes ${Date.now()}`);
    const card = page.getByTestId("research");
    await expect(card.getByRole("listitem")).toHaveCount(3, { timeout: 20_000 });
    await card.getByRole("button", { name: "Stop" }).click();
    await expect(card).toHaveAttribute("data-status", "stopped");
    await expect(card.getByText("Research stopped.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    // Stopped for good: no report turns up later.
    await page.waitForTimeout(8_000);
    await page.reload();
    await expect(page.getByTestId("research")).toHaveAttribute("data-status", "stopped");
    await expect(page.getByTestId("reply")).toHaveCount(0);
  });

  test("files can't be researched, and the message comes back to the box", async ({ page }) => {
    await start(page);
    await page.getByTestId("file-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
    await page.getByRole("button", { name: "Deep research" }).click();
    await page.getByLabel("Message Depeche").fill("Research my notes");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Deep research works from your message only")).toBeVisible();
    await expect(page.getByLabel("Message Depeche")).toHaveValue("Research my notes");
  });
});
