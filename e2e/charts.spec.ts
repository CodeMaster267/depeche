import { expect, test, type Page } from "@playwright/test";
import { OWNER, noSidewaysScroll, signInWithPassword, watchErrors } from "./helpers";

/**
 * Charts in replies and Python that analyses attached files in a sandbox. Replies come from the
 * stand-in model: "draw charts" makes it write two ```chart blocks, and "analyse" makes it write
 * three ```python run blocks (pandas on the attached CSV, a matplotlib figure, and one that tries
 * to read the page's cookies, which must fail).
 */

test.setTimeout(180_000);

async function ready(page: Page) {
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
  const dialog = page.getByRole("dialog", { name: "Choose a model" });
  await dialog.getByRole("button", { name: /Gemini 3\.8 Flash/ }).click();
  await expect(dialog).toHaveCount(0);
}

test("charts in replies are drawn, show values and can be read as a table", async ({ page }, info) => {
  const errors = watchErrors(page);
  await ready(page);
  await page.getByLabel("Message Depeche").fill(`Please draw charts ${Date.now()}`);
  await page.getByRole("button", { name: "Send" }).click();
  const reply = page.getByTestId("reply").last();
  await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });

  const charts = reply.getByTestId("chart");
  await expect(charts).toHaveCount(2);
  const bar = charts.first();
  await expect(bar).toHaveAttribute("data-type", "bar");
  await expect(bar.getByText("Spending by month")).toBeVisible();
  // Two series of four months.
  await expect(bar.locator("svg[role=img] rect[data-value]")).toHaveCount(8);

  // Hover (or tap) shows the month's values.
  const svg = bar.locator("svg[role=img]");
  const box = (await svg.boundingBox())!;
  if (info.project.use.hasTouch) await svg.tap({ position: { x: box.width * 0.2, y: box.height / 2 } });
  else await svg.hover({ position: { x: box.width * 0.2, y: box.height / 2 } });
  const tip = bar.locator(".md-chart-tip");
  await expect(tip).toContainText("Jan");
  await expect(tip).toContainText("£320");
  await expect(tip).toContainText("£120");

  await bar.screenshot({ path: `test-results/chart-bar-${info.project.name}.png` });

  // The legend turns a series off.
  await bar.getByRole("button", { name: "Travel" }).click();
  await expect(bar.getByRole("button", { name: "Travel" })).toHaveAttribute("aria-pressed", "false");
  await expect(bar.locator("svg[role=img] rect[data-value]")).toHaveCount(4);

  // The numbers as a table.
  await bar.getByRole("button", { name: "Data" }).click();
  await expect(bar.getByRole("table")).toContainText("£350");

  const pie = charts.nth(1);
  await expect(pie).toHaveAttribute("data-type", "pie");
  await expect(pie.locator("path[data-value]")).toHaveCount(3);
  await expect(pie.getByText("69%")).toBeVisible(); // 900 of 1300
  await pie.screenshot({ path: `test-results/chart-pie-${info.project.name}.png` });

  await page.screenshot({ path: `test-results/charts-${info.project.name}.png`, fullPage: false });
  await noSidewaysScroll(page);
  expect(errors.filter((e) => !/_rsc=.*access control checks/.test(e))).toEqual([]);
});

test("Python in a reply analyses the attached CSV in a sandbox", async ({ page }, info) => {
  const errors = watchErrors(page);
  await ready(page);
  const csv = "Month,Amount\nJan,100\nFeb,250\nMar,175\n";
  await page.getByTestId("file-input").setInputFiles([{ name: "Sales.csv", mimeType: "text/csv", buffer: Buffer.from(csv) }]);
  await expect(page.getByTestId("attachment").first()).toHaveAttribute("data-status", "ready");
  await page.getByLabel("Message Depeche").fill(`Please analyse this ${Date.now()}`);
  await page.getByRole("button", { name: "Send" }).click();
  const reply = page.getByTestId("reply").last();
  await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });

  const blocks = reply.locator("[data-testid=run-code][data-auto]");
  await expect(blocks).toHaveCount(3);
  // They start by themselves, one after another. Pyodide and pandas come from the CDN.
  const pandas = blocks.first();
  await expect(pandas).toHaveAttribute("data-phase", "done", { timeout: 150_000 });
  await expect(pandas.getByTestId("run-text")).toContainText("Rows: 3");
  await expect(pandas.getByTestId("run-text")).toContainText("Total: 525");
  const chart = pandas.getByTestId("chart");
  await expect(chart).toHaveAttribute("data-type", "line");
  await expect(chart.getByText("Amount by month")).toBeVisible();

  const mpl = blocks.nth(1);
  await expect(mpl).toHaveAttribute("data-phase", "done", { timeout: 120_000 });
  await expect(mpl.getByRole("img", { name: "Chart drawn by the code" })).toBeVisible();

  // The sandbox can't reach the page: no document, so no cookies.
  const sneaky = blocks.nth(2);
  await expect(sneaky).toHaveAttribute("data-phase", "done", { timeout: 60_000 });
  await expect(sneaky.getByTestId("run-error")).toContainText(/AttributeError|has no attribute 'document'/);

  // Code is tucked away for blocks that run by themselves, and can be shown.
  await pandas.getByRole("button", { name: "Show code" }).click();
  await expect(pandas.locator("pre")).toContainText('pd.read_csv("Sales.csv")');

  await pandas.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/analysis-${info.project.name}.png`, fullPage: false });

  // The printed results can go back to the chat.
  await pandas.getByRole("button", { name: "Send results to the chat" }).click();
  await expect(page.getByTestId("user-message").last()).toContainText("Total: 525");
  await expect(page.getByTestId("reply").last()).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
  await noSidewaysScroll(page);
  expect(errors.filter((e) => !/_rsc=.*access control checks/.test(e))).toEqual([]);
});
