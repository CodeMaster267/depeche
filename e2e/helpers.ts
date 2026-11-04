import { expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * The browser tests run against a real local Supabase (`supabase start`), so sign-in, emails and
 * the privacy rules behave as they will in production. Emails land in Mailpit instead of inboxes.
 */
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
export const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
export const OWNER = { email: "hasan@example.com", password: "owner-password-123", name: "Hasan" };

export function admin() {
  return createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** A unique address per test and browser, so tests can run side by side. */
export function uniqueEmail(tag: string) {
  return `${tag}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.com`;
}

type MailSummary = { ID: string; To: { Address: string }[]; Created: string };

/** The newest email to `to`, waiting for it to arrive. Returns its link and code. */
export async function latestEmail(to: string, after = 0): Promise<{ link: string; code: string }> {
  let found: MailSummary | undefined;
  await expect
    .poll(
      async () => {
        const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
        const body = (await res.json()) as { messages: MailSummary[] };
        found = body.messages.find((m) => new Date(m.Created).getTime() >= after);
        return Boolean(found);
      },
      { timeout: 15_000, message: `email to ${to}` },
    )
    .toBe(true);
  const msg = (await (await fetch(`${MAILPIT}/api/v1/message/${found!.ID}`)).json()) as { HTML: string; Text: string };
  const link = /href="([^"]*\/auth\/confirm[^"]*)"/.exec(msg.HTML)?.[1]?.replaceAll("&amp;", "&");
  const code = /\b(\d{6})\b/.exec(msg.Text || msg.HTML)?.[1];
  expect(link, "sign-in link in email").toBeTruthy();
  expect(code, "code in email").toBeTruthy();
  return { link: link!, code: code! };
}

export async function emailCount(to: string): Promise<number> {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  return ((await res.json()) as { messages_count: number }).messages_count;
}

export async function signInWithPassword(page: Page, identifier: string, password: string) {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Use a username and password" }).click();
  await page.getByLabel("Username or email").fill(identifier);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/** As the signed-in admin, create an invite and return its link. */
export async function createInvite(page: Page, name: string, email: string): Promise<string> {
  await page.goto("/family");
  await page.getByLabel("Their name").fill(name);
  await page.getByLabel("Their email").fill(email);
  await page.getByRole("button", { name: "Create invite link" }).click();
  const link = (await page.getByTestId("invite-link").textContent())!.trim();
  expect(link).toContain("/invite/");
  return link;
}

export async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(0);
}

/** Collects page errors and console errors so a test can assert there were none. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  // Safari can also raise the cancelled prefetch below as a page error.
  page.on("pageerror", (e) => {
    if (/_rsc=.* due to access control checks/.test(e.message)) return;
    errors.push(e.message);
  });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // Safari logs a Next.js page prefetch (`?_rsc=`) that a navigation cancels as an "access
    // control" error. The header links prefetch pages, so leaving a page mid-prefetch triggers it.
    // It is the browser dropping a request we no longer need, not a fault in Depeche.
    if (/_rsc=.* due to access control checks/.test(m.text())) return;
    errors.push(m.text());
  });
  return errors;
}

/** A link in the chats menu: always shown on wide screens, behind the menu button on phones. */
export async function menuLink(page: Page, name: string) {
  const open = page.getByRole("button", { name: "Open menu" });
  if (await open.isVisible()) await open.click();
  // Your pages sit in the account menu at the foot of the chats list; other pages show them in the header.
  const account = page.getByRole("button", { name: /account menu$/ });
  const link = page.getByRole("link", { name, exact: true });
  await account.or(link).first().waitFor({ timeout: 5_000 }).catch(() => {});
  if ((await account.isVisible()) && (await account.getAttribute("aria-expanded")) !== "true") await account.click();
  return link;
}
