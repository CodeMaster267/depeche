import { expect, test } from "@playwright/test";

test("the keep-alive check answers without signing in, and says nothing else", async ({ page }) => {
  const res = await page.goto("/api/keep-alive");
  expect(res?.status()).toBe(200);
  expect(res?.headers()["cache-control"]).toContain("no-store");
  expect(await res?.json()).toEqual({ ok: true });
  await expect(page).toHaveURL(/\/api\/keep-alive$/);
});
