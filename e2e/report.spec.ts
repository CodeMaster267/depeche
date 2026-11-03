import { expect, test, type Page } from "@playwright/test";
import { admin, menuLink, noSidewaysScroll, signInWithPassword, uniqueEmail, watchErrors } from "./helpers";

/**
 * Reporting a bug. Each test gets its own family member, so the daily limit of three reports is
 * per test and the four browsers can run side by side.
 */
async function newMember(name: string) {
  const db = admin();
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  const email = uniqueEmail("reporter");
  const password = "reporter-password-123";
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  await db.from("profiles").insert({ id: data.user.id, family_id: owner!.family_id, display_name: name }).throwOnError();
  return { id: data.user.id, email, password };
}

async function send(page: Page, text: string) {
  await page.getByLabel("What went wrong?").fill(text);
  await page.getByRole("button", { name: "Send report" }).click();
}

test("a member reports a bug from the chat screen and sees it in their list", async ({ page }) => {
  const errors = watchErrors(page);
  const me = await newMember("Reporter");
  await signInWithPassword(page, me.email, me.password);
  await expect(page.getByRole("heading", { name: "Hi, Reporter." })).toBeVisible();

  await (await menuLink(page, "Report a bug")).click();
  await expect(page.getByRole("heading", { name: "Report a bug" })).toBeVisible();
  await noSidewaysScroll(page);

  await send(page, "The copy button on code blocks does nothing on my phone.");
  await expect(page.getByText(/on its way/)).toBeVisible();
  // The box is empty again, ready for another report.
  await expect(page.getByLabel("What went wrong?")).toHaveValue("");
  const list = page.getByTestId("my-reports");
  await expect(list.getByText("The copy button on code blocks does nothing on my phone.")).toBeVisible();
  await expect(list.getByText("Sent", { exact: true })).toBeVisible();

  // The server recorded who sent it from the session, plus the page and browser, never the owner flag.
  const { data } = await admin().from("bug_reports").select("page, user_agent, from_owner, status").eq("owner_id", me.id);
  expect(data).toEqual([{ page: "/", user_agent: expect.stringMatching(/Mozilla/), from_owner: false, status: "new" }]);
  expect(errors).toEqual([]);
});

test("a fourth report in a day is refused, and what was written is kept", async ({ page }) => {
  const me = await newMember("Busy");
  await signInWithPassword(page, me.email, me.password);
  await expect(page.getByRole("heading", { name: "Hi, Busy." })).toBeVisible();
  await page.goto("/report");
  for (const n of [1, 2, 3]) {
    await send(page, `Report number ${n} about something broken.`);
    await expect(page.getByTestId("my-reports").getByText(`Report number ${n} about something broken.`)).toBeVisible();
  }
  await send(page, "One report too many for today.");
  await expect(page.locator("p[role=alert]")).toHaveText(/3 bug reports a day/);
  await expect(page.getByLabel("What went wrong?")).toHaveValue("One report too many for today.");
  await expect(page.getByTestId("my-reports").locator("li")).toHaveCount(3);
});

test("people only see their own reports", async ({ browser }) => {
  const a = await newMember("Alpha");
  const b = await newMember("Bravo");
  const pageA = await (await browser.newContext()).newPage();
  await signInWithPassword(pageA, a.email, a.password);
  await expect(pageA.getByRole("heading", { name: "Hi, Alpha." })).toBeVisible();
  await pageA.goto("/report");
  await send(pageA, "Alpha's private report about the sidebar.");
  await expect(pageA.getByTestId("my-reports").getByText("Alpha's private report about the sidebar.")).toBeVisible();

  const pageB = await (await browser.newContext()).newPage();
  await signInWithPassword(pageB, b.email, b.password);
  await expect(pageB.getByRole("heading", { name: "Hi, Bravo." })).toBeVisible();
  await pageB.goto("/report");
  await expect(pageB.getByRole("heading", { name: "Report a bug" })).toBeVisible();
  await expect(pageB.getByText("Alpha's private report")).toHaveCount(0);
});
