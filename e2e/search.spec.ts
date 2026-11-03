import { expect, test, type Page } from "@playwright/test";
import { OWNER, admin, noSidewaysScroll, signInWithPassword, watchErrors } from "./helpers";

/**
 * Web search. The stand-in AI (DEPECHE_FAKE_AI) searches when a message says "latest" and web
 * search is on, then answers with numbered citations, three sources and, for Google, Google's
 * search suggestions (with a script in them, which must never run).
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

test.describe("web search", () => {
  test("a reply searches the web, cites its sources and counts the search fees", async ({ page }) => {
    const errors = watchErrors(page);
    await start(page);
    const globe = page.getByRole("button", { name: "Search the web" });
    await expect(globe).toHaveAttribute("aria-pressed", "true");

    const question = `What's the latest on quadratics, slowly? ${Date.now()}`;
    await send(page, question);
    const reply = page.getByTestId("reply").last();
    await expect(reply.getByTestId("searching")).toBeVisible();
    await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
    await expect(reply.getByTestId("searching")).toHaveCount(0);

    // Numbered citations in the text link straight to the pages.
    const cite = reply.locator("a.cite").first();
    await expect(cite).toHaveText("1");
    await expect(cite).toHaveAttribute("href", "https://en.wikipedia.org/wiki/Quadratic_formula");
    await expect(cite).toHaveAttribute("target", "_blank");

    // The sources open into a numbered list.
    const sources = reply.getByTestId("sources");
    const toggle = sources.getByRole("button", { name: "Searched the web · 3 sources" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    // The searches it ran are listed above the pages.
    await expect(sources.getByText(/^“What's the latest on quadratics/)).toBeVisible();
    await expect(sources.getByText("bbc.co.uk")).toBeVisible();
    await expect(sources.getByRole("link", { name: /Quadratic formula - Wikipedia/ })).toHaveAttribute("rel", /noopener/);
    await expect(sources.getByText("2 web searches, included in the cost below.")).toBeVisible();

    // Google's suggestions are shown in a sandbox where its scripts can't run.
    const frame = reply.getByTestId("search-suggestions");
    await expect(frame).toHaveAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
    await expect(page.frameLocator("[data-testid=search-suggestions]").getByRole("link", { name: "quadratic formula" })).toBeVisible();
    expect(await page.title()).not.toBe("pwned");
    await noSidewaysScroll(page);

    // The saved reply keeps its sources, and its cost includes two searches at Google's $0.014.
    await page.reload();
    await expect(page.getByTestId("reply").last().getByTestId("sources")).toBeVisible();
    const db = admin();
    const { data: msg } = await db
      .from("messages")
      .select("id, content")
      .eq("role", "assistant")
      // Other browsers run at the same time, so look only in this chat.
      .eq("chat_id", page.url().split("/c/")[1])
      .order("created_at", { ascending: false })
      .limit(1)
      .single<{ id: string; content: { cost: number; searches: number; sources: unknown[] } }>();
    expect(msg!.content.searches).toBe(2);
    expect(msg!.content.sources).toHaveLength(3);
    const tokens = (3000 * 1.5 + 200 * 7.5) / 1_000_000;
    expect(msg!.content.cost).toBeCloseTo(tokens + 0.028, 6);
    const { data: usage } = await db.from("usage_events").select("cost_usd").eq("message_id", msg!.id).single();
    expect(Number(usage!.cost_usd)).toBeCloseTo(tokens + 0.028, 5);
    // The browser reporting that it blocked the planted script is the sandbox doing its job.
    expect(errors.filter((e) => !/_rsc=.*access control checks|sandbox|about:srcdoc/i.test(e))).toEqual([]);
  });

  test("with web search off, the model answers without searching", async ({ page }) => {
    await start(page);
    const globe = page.getByRole("button", { name: "Search the web" });
    await globe.click();
    await expect(globe).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("status")).toHaveText("Web search off");
    await send(page, "What's the latest news?");
    const reply = page.getByTestId("reply").last();
    await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
    await expect(reply).toContainText("worked answer");
    await expect(reply.getByTestId("sources")).toHaveCount(0);

    // The choice is remembered on this device.
    await page.reload();
    await expect(page.getByRole("button", { name: "Search the web" })).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "Search the web" }).click();
    await expect(page.getByRole("button", { name: "Search the web" })).toHaveAttribute("aria-pressed", "true");
  });

  test("a key that can't search still gets an answer, and says so", async ({ page }) => {
    await start(page);
    await send(page, "latest nosearch question");
    const reply = page.getByTestId("reply").last();
    await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
    await expect(reply).toContainText("worked answer");
    await expect(reply.getByText(/Web search wasn't available, so this answer comes from the model's own knowledge/)).toBeVisible();
  });

  test("a Google key whose search allowance is used up still gets a full answer", async ({ page }) => {
    await start(page);
    await send(page, "latest noquota question");
    const reply = page.getByTestId("reply").last();
    await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
    await expect(reply).toContainText("worked answer");
    await expect(reply.getByText(/Google's search allowance for your family's key is used up/)).toBeVisible();
  });
});
