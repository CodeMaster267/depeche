import { expect, test, type Page } from "@playwright/test";
import { OWNER, admin, noSidewaysScroll, signInWithPassword, uniqueEmail, watchErrors } from "./helpers";

/**
 * My look: each person redesigns their own Depeche. A brief from the chat (or typed on My look) is
 * built by the stand-in designer, previewed with Keep or Undo (going back on its own after 15
 * seconds), checked for readability and family-friendliness, counted against the build allowance
 * (failed builds aren't), kept in the history, and reset. Admins set allowances, switch designs
 * off, design for a member, and see the activity and to-do lists.
 */

const phone = (page: Page) => (page.viewportSize()?.width ?? 1000) < 768;

/** The owner's family has a (test) Google key, so models and the designer are there. */
async function ensureKey(page: Page) {
  const db = admin();
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  const { data: key } = await db.from("provider_keys").select("id").eq("family_id", owner!.family_id).eq("provider", "google").maybeSingle();
  if (!key) {
    await signInWithPassword(page, OWNER.email, OWNER.password);
    await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
    await addGoogleKey(page);
    await page.context().clearCookies();
  }
  return owner!.family_id as string;
}

async function addGoogleKey(page: Page) {
  await page.goto("/family");
  const row = page.getByTestId("provider-google");
  await expect(row.getByText(/Not added|ends in/)).toBeVisible();
  if (await row.getByText("Not added").isVisible()) {
    await row.getByLabel("Google (Gemini) API key").fill("test-google-key-1234567890abcd");
    await row.getByRole("button", { name: "Save key" }).click();
    await expect(row.getByText(/ends in/)).toBeVisible();
  }
}

async function newPerson(familyId: string, name: string, role: "member" | "admin" = "member") {
  const db = admin();
  const email = uniqueEmail("look");
  const { data: user } = await db.auth.admin.createUser({ email, password: "member-password-123", email_confirm: true });
  await db.from("profiles").insert({ id: user.user!.id, family_id: familyId, display_name: name, role });
  return { email, id: user.user!.id };
}

async function ask(page: Page, text: string) {
  const box = page.getByLabel("Message Depeche");
  const send = page.getByRole("button", { name: "Send" });
  await expect(async () => {
    await box.fill(text);
    await expect(send).toBeEnabled({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await send.click();
}

const bodyBackground = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test("a person redesigns Depeche from a chat, keeps it, and goes back to standard", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = watchErrors(page);
  const familyId = await ensureKey(page);
  const tara = await newPerson(familyId, "Tara");
  await signInWithPassword(page, tara.email, "member-password-123");
  await expect(page.getByRole("heading", { name: "Hi, Tara." })).toBeVisible();
  const standard = await bodyBackground(page);

  // The assistant writes a brief; Build sends it to the designer.
  await ask(page, "redesign: make it playful, with a memory button and the chats on the right");
  const card = page.getByTestId("design-brief");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("make it playful, with a memory button and the chats on the right");
  await expect(card.getByTestId("design-meter")).toHaveText(/0 of 10 design builds used/);
  await card.getByRole("button", { name: "Build this look" }).click();

  // Previewed straight away, with Keep or Undo.
  const bar = page.getByRole("dialog", { name: "Keep this look?" });
  await expect(bar).toBeVisible({ timeout: 15_000 });
  await expect(bar).toContainText("New look: Sunny playground");
  await expect.poll(() => bodyBackground(page)).not.toBe(standard);
  await expect(card.getByTestId("design-meter")).toHaveText(/1 of 10 design builds used/);
  await noSidewaysScroll(page);
  await bar.getByRole("button", { name: "Keep" }).click();
  await expect(bar).toHaveCount(0);
  // Let the screen finish catching up before leaving it (Safari reports requests cut off by leaving).
  await page.waitForLoadState("networkidle");

  // Kept: still there after a reload, with the new greeting, the new button and the chats on the right.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Hey Tara!" })).toBeVisible();
  await expect(page.getByText("What shall we dream up today?")).toBeVisible();
  await expect(page.getByRole("link", { name: "My memory" }).filter({ visible: true })).toBeVisible();
  if (phone(page)) {
    await page.getByRole("button", { name: "Open menu" }).click();
    const drawer = page.locator("[data-part=drawer]");
    await expect(drawer).toBeVisible();
    const box = (await drawer.boundingBox())!;
    expect(box.x + box.width).toBeGreaterThan(page.viewportSize()!.width - 2);
    expect(box.x).toBeGreaterThan(10);
    await drawer.getByRole("button", { name: "Close menu" }).click();
  } else {
    const side = (await page.locator("[data-part=sidebar-desktop]").boundingBox())!;
    expect(side.x).toBeGreaterThan(page.viewportSize()!.width / 2);
  }
  await noSidewaysScroll(page);

  // The new button goes where it says.
  await page.getByRole("link", { name: "My memory" }).filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/memory/);

  // My look shows it, and the way back.
  await page.goto("/design");
  await expect(page.getByTestId("current-look")).toContainText("Sunny playground");
  await expect(page.getByTestId("build-meter")).toContainText("1 of 10 design builds used this month");
  await page.getByRole("button", { name: "Back to standard Depeche" }).click();
  await expect(page.getByTestId("current-look")).toContainText("Standard Depeche");
  await expect(page.getByTestId("look-history")).toContainText("Sunny playground");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Hi, Tara." })).toBeVisible();
  expect(await bodyBackground(page)).toBe(standard);
  // Leaving a chat cuts off its background requests, which Safari reports as "access control
  // checks"; that is the browser dropping a request nobody needs any more.
  expect(errors.filter((e) => !/due to access control checks/.test(e))).toEqual([]);

  // The sign-in page is never redesigned.
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await expect(page.locator("style[data-look]")).toHaveCount(0);
});

test("looks go back on their own, stay readable and family friendly, and failures don't count", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  const familyId = await ensureKey(page);
  const uma = await newPerson(familyId, "Uma");
  await signInWithPassword(page, uma.email, "member-password-123");
  await expect(page.getByRole("heading", { name: "Hi, Uma." })).toBeVisible();

  await page.goto("/design");
  const meter = page.getByTestId("build-meter");
  await expect(meter).toContainText("0 of 10");
  const brief = page.getByLabel("Describe the look");
  const buildButton = page.getByRole("button", { name: "Build my look" });
  const describe = async (text: string) => {
    // Typing before the page is ready can be lost, so type again until Build is ready.
    await expect(async () => {
      await brief.fill(text);
      await expect(buildButton).toBeEnabled({ timeout: 1000 });
    }).toPass({ timeout: 10_000 });
  };
  const alert = (text: string) => page.getByRole("alert").filter({ hasText: text });
  const used = async () => Number((await admin().rpc("design_builds_used", { p_person: uma.id })).data);

  // Pale grey text is corrected before anyone sees it, and nobody pressing Keep means it goes back.
  await describe("unreadable pale grey text everywhere");
  await buildButton.click();
  const bar = page.getByRole("dialog", { name: "Keep this look?" });
  await expect(bar).toBeVisible({ timeout: 15_000 });
  await expect(bar).toContainText("Some colours were adjusted so text stays easy to read.");
  const fg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--fg").trim());
  expect(fg).not.toBe("#dddddd");
  await expect(bar).toContainText(/Goes back in \d+s/);
  await expect(bar).toHaveCount(0, { timeout: 20_000 });
  // My look refreshes by itself: the build counted, and the look went back.
  await expect(meter).toContainText("1 of 10");
  await expect(page.getByTestId("current-look")).toContainText("Standard Depeche");
  await expect(page.getByTestId("look-history")).toContainText("Not kept");

  // Trying an earlier look again is free.
  await page.getByTestId("look-history").getByRole("button", { name: "Try it again" }).first().click();
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "Undo" }).click();
  await expect(bar).toHaveCount(0);

  // A build that fails isn't counted.
  await describe("a broken answer please");
  await buildButton.click();
  await expect(alert("failed builds don't count")).toBeVisible({ timeout: 15_000 });
  await expect.poll(used).toBe(1);

  // Not family friendly: turned down, not counted.
  await describe("make it a nsfw theme");
  await buildButton.click();
  await expect(alert("family friendly")).toBeVisible({ timeout: 15_000 });
  await expect.poll(used).toBe(1);
  await noSidewaysScroll(page);
  // The browser reports the failed and turned-down builds above, which were meant to fail.
  expect(errors.filter((e) => !/status of (502|422)/.test(e))).toEqual([]);
});

test("a family admin sets builds, designs for a member, sees the activity, and can switch designs off", async ({ page }) => {
  test.setTimeout(150_000);
  const errors = watchErrors(page);
  const db = admin();
  // A family of their own, so switching designs off can't affect other tests.
  const { data: owner } = await db.from("profiles").select("id").eq("is_app_owner", true).single();
  const { data: fam } = await db.from("families").insert({ name: `Looks ${Date.now().toString(36)}`, created_by: owner!.id }).select("id").single();
  const ada = await newPerson(fam!.id, "Ada", "admin");
  const ben = await newPerson(fam!.id, "Ben");

  await signInWithPassword(page, ada.email, "member-password-123");
  await expect(page.getByRole("heading", { name: "Hi, Ada." })).toBeVisible();
  await addGoogleKey(page);
  await page.getByRole("link", { name: "Manage designs" }).click();
  await expect(page).toHaveURL(/\/family\/designs/);
  const people = page.getByTestId("design-people");
  await expect(people).toContainText("Ben");

  // Ben gets 3 builds a month.
  await people.getByLabel("Builds a month for Ben").fill("3");
  await people.locator("li", { hasText: "Ben" }).getByRole("button", { name: "Save" }).click();
  await expect(people.locator("li", { hasText: "Ben" })).toContainText("Saved.");

  // Designing for Ben: Ada sees a preview, Ben gets Keep or Undo later.
  await people.getByRole("link", { name: "Design a look for Ben" }).click();
  await expect(page.getByRole("heading", { name: "A look for Ben" })).toBeVisible();
  const forBen = page.getByRole("button", { name: "Build Ben's look" });
  await expect(async () => {
    await page.getByLabel("Describe the look").fill("playful, and make the logo dancing across the screen");
    await expect(forBen).toBeEnabled({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await forBen.click();
  const bar = page.getByRole("dialog", { name: "Keep this look?" });
  await expect(bar).toContainText("This is how Ben's Depeche will look", { timeout: 15_000 });
  await expect(bar).toContainText("Couldn't do yet: Make the logo dance across the screen");
  await bar.getByRole("button", { name: "Close preview" }).click();
  await expect(bar).toHaveCount(0);

  await page.goto("/family/designs");
  await expect(page.getByTestId("design-activity")).toContainText("Ada for Ben: Built");
  await expect(page.getByTestId("design-todo")).toContainText("Make the logo dance across the screen");
  await noSidewaysScroll(page);

  // Ben opens Depeche and keeps it.
  await page.context().clearCookies();
  await signInWithPassword(page, ben.email, "member-password-123");
  await expect(bar).toContainText("Ada made you a new look: Sunny playground", { timeout: 15_000 });
  await bar.getByRole("button", { name: "Keep" }).click();
  await expect(bar).toHaveCount(0);
  // Let the screen finish catching up before leaving it (Safari reports requests cut off by leaving).
  await page.waitForLoadState("networkidle");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Hey Ben!" })).toBeVisible();
  await page.goto("/design");
  await expect(page.getByTestId("build-meter")).toContainText("0 of 3");

  // The kill switch: off means everyone sees standard Depeche, and nobody can build.
  await page.context().clearCookies();
  await signInWithPassword(page, ada.email, "member-password-123");
  await expect(page.getByRole("heading", { name: "Hi, Ada." })).toBeVisible();
  await page.goto("/family/designs");
  await page.getByRole("switch", { name: /Let people redesign/ }).uncheck();
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.getByText("Saved.").first()).toBeVisible();

  await page.context().clearCookies();
  await signInWithPassword(page, ben.email, "member-password-123");
  await expect(page.getByRole("heading", { name: "Hi, Ben." })).toBeVisible();
  await page.goto("/design");
  await expect(page.getByText("Your family admin has turned off redesigns for now")).toBeVisible();
  await expect(page.getByRole("button", { name: "Build my look" })).toBeDisabled();
  // This test signs in and out four times. Safari reports a background catch-up request that a
  // sign-out cuts off as "Load failed"; that is the browser dropping it, not a fault.
  expect(errors.filter((e) => e !== "Load failed")).toEqual([]);
});
