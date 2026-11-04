import { expect, test, type Page } from "@playwright/test";
import { OWNER, admin, menuLink, noSidewaysScroll, signInWithPassword, uniqueEmail, watchErrors } from "./helpers";

/** The Health screen: admins see their family, the owner also sees the system, members see none of it. */

async function signInOwner(page: Page) {
  await signInWithPassword(page, OWNER.email, OWNER.password);
  await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
}

async function person(family: string, name: string, role: "admin" | "member") {
  const db = admin();
  const email = uniqueEmail(name.toLowerCase());
  const password = `${name.toLowerCase()}-password-123`;
  const { data } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  await db.from("profiles").insert({ id: data.user!.id, family_id: family, display_name: name, role });
  return { email, password };
}

test("the owner sees their family's health and the system's, with alerts in plain words", async ({ page }) => {
  const errors = watchErrors(page);
  await admin().from("system_checks").insert({ kind: "backup", ok: false, detail: "test failure" });
  await signInOwner(page);
  await (await menuLink(page, "Health")).click();
  await expect(page.getByRole("heading", { name: "Health", level: 1 })).toBeVisible();
  await expect(page.getByText(/Answering \(\d+ ms\)/)).toBeVisible();
  await expect(page.getByTestId("alerts")).toContainText(/backup/i);
  await expect(page.getByTestId("family-spend")).toContainText("left");
  await expect(page.getByRole("heading", { name: "System (only you see this)" })).toBeVisible();
  await expect(page.getByText(/MB of 500 MB free/)).toBeVisible();
  await noSidewaysScroll(page);
  expect(errors).toEqual([]);
});

test("another family's admin sees only their own family, and members can't open it", async ({ browser, contextOptions }) => {
  const db = admin();
  const { data: owner } = await db.from("profiles").select("id, family_id").eq("is_app_owner", true).single();
  const { data: fam } = await db
    .from("families")
    .insert({ name: `Health ${Math.random().toString(36).slice(2, 7)}`, created_by: owner!.id })
    .select("id")
    .single();
  const boss = await person(fam!.id, "Dana", "admin");
  const member = await person(owner!.family_id, "Rumi", "member");

  const page = await (await browser.newContext(contextOptions)).newPage();
  await signInWithPassword(page, boss.email, boss.password);
  await expect(page.getByRole("heading", { name: "Hi, Dana." })).toBeVisible();
  await page.goto("/health");
  await expect(page.getByRole("heading", { name: "Health", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: /System/ })).toHaveCount(0);
  await expect(page.getByRole("main")).not.toContainText("Hasan");
  await expect(page.getByText("No AI keys yet. Add one on the Family page.")).toBeVisible();

  const m = await (await browser.newContext(contextOptions)).newPage();
  await signInWithPassword(m, member.email, member.password);
  await expect(m.getByRole("heading", { name: "Hi, Rumi." })).toBeVisible();
  await m.goto("/health");
  await expect(m).not.toHaveURL(/\/health/);
});
