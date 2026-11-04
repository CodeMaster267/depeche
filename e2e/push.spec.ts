import { expect, test, type Page } from "@playwright/test";
import { createECDH, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { OWNER, admin, signInWithPassword, uniqueEmail, watchErrors } from "./helpers";

/**
 * Answer-ready notifications. The pushes are real (signed and encrypted exactly as for Apple or
 * Google), but go to a little receiver in the test instead of a push service, which the test then
 * decrypts with the device's keys.
 */
const ece = createRequire(import.meta.url)("http_ece") as {
  decrypt: (body: Buffer, params: { version: string; privateKey: ReturnType<typeof createECDH>; authSecret: Buffer }) => Buffer;
};

type Received = { headers: Record<string, string | string[] | undefined>; body: Buffer };

async function receiver(): Promise<{ url: string; got: Received[]; server: Server }> {
  const got: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      got.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(201).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/push/${randomBytes(6).toString("hex")}`, got, server };
}

async function ensureGoogleKey(page: Page) {
  await page.goto("/family");
  const row = page.getByTestId("provider-google");
  await expect(row.getByText(/Not added|ends in/)).toBeVisible();
  if (await row.getByText("Not added").isVisible()) {
    await row.getByLabel("Google (Gemini) API key").fill("test-google-key-1234567890abcd");
    await row.getByRole("button", { name: "Save key" }).click();
    await expect(row.getByText(/ends in/)).toBeVisible();
  }
}

async function member(page: Page, name: string) {
  await signInWithPassword(page, OWNER.email, OWNER.password);
  await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
  await ensureGoogleKey(page);
  await page.context().clearCookies();
  const db = admin();
  const email = uniqueEmail("push");
  const { data: user } = await db.auth.admin.createUser({ email, password: "member-password-123", email_confirm: true });
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  await db.from("profiles").insert({ id: user.user!.id, family_id: owner!.family_id, display_name: name });
  await signInWithPassword(page, email, "member-password-123");
  await expect(page.getByRole("heading", { name: `Hi, ${name}.` })).toBeVisible();
  return user.user!.id;
}

test("an answer finished after leaving sends an encrypted notification; one watched doesn't", async ({ page }) => {
  const userId = await member(page, "Nia");
  const push = await receiver();
  try {
    // The device's own keys, as a browser makes when it subscribes.
    const device = createECDH("prime256v1");
    device.generateKeys();
    const authSecret = randomBytes(16);
    const keys = { p256dh: device.getPublicKey().toString("base64url"), auth: authSecret.toString("base64url") };

    // Only real push services (and, in tests, this local receiver) are accepted.
    const refused = await page.request.post("/api/push/subscribe", { data: { endpoint: "https://evil.example/x", keys } });
    expect(refused.status()).toBe(400);
    const ok = await page.request.post("/api/push/subscribe", { data: { endpoint: push.url, keys, device: "Test" } });
    expect(ok.status()).toBe(200);
    const { data: subs } = await admin().from("push_subscriptions").select("device").eq("owner_id", userId);
    expect(subs).toEqual([{ device: "Test" }]);

    // Watched all the way: no notification.
    const watched = await page.request.post("/api/chat", {
      data: { model: "gemini-3.8-flash", clientRequestId: crypto.randomUUID(), text: "Hello" },
    });
    expect(await watched.text()).toContain('"type":"done"');

    // Left, came back, left again before it finished: one notification, for this chat.
    const requestId = crypto.randomUUID();
    for (const away of [true, false, true]) {
      expect((await page.request.post("/api/push/away", { data: { requestId, away } })).status()).toBe(200);
    }
    const left = await page.request.post("/api/chat", {
      data: { model: "gemini-3.8-flash", clientRequestId: requestId, text: "Plan a trip to Lisbon" },
    });
    const events = (await left.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; chatId?: string });
    const chatId = events.find((e) => e.type === "start")!.chatId;
    expect(events.at(-1)!.type).toBe("done");

    await expect.poll(() => push.got.length, { timeout: 10_000 }).toBe(1);
    const [msg] = push.got;
    expect(String(msg.headers.authorization)).toMatch(/^vapid t=.+, k=.+/);
    expect(msg.headers["content-encoding"]).toBe("aes128gcm");
    expect(Number(msg.headers.ttl)).toBeGreaterThan(0);
    const note = JSON.parse(ece.decrypt(msg.body, { version: "aes128gcm", privateKey: device, authSecret }).toString("utf8"));
    expect(note).toMatchObject({ body: "Your answer is ready.", url: `/c/${chatId}` });
    expect(note.title).toMatch(/Lisbon/);
    // The mark is used up, and the answer's words never travel in the notification.
    expect(Object.keys(note).sort()).toEqual(["body", "tag", "title", "url"]);
    const { data: marks } = await admin().from("push_away").select("request_id").eq("owner_id", userId);
    expect(marks).toEqual([]);

    // The test button reaches the same device.
    const tested = await page.request.post("/api/push/test");
    expect(await tested.json()).toEqual({ sent: 1 });
    await expect.poll(() => push.got.length).toBe(2);

    // Turning off forgets the device.
    await page.request.delete("/api/push/subscribe", { data: { endpoint: push.url } });
    const { data: after } = await admin().from("push_subscriptions").select("id").eq("owner_id", userId);
    expect(after).toEqual([]);
  } finally {
    push.server.close();
  }
});

test("leaving the chat screen mid-answer asks for a notification; staying doesn't", async ({ page }) => {
  await member(page, "Pia");
  const push = await receiver();
  try {
    const device = createECDH("prime256v1");
    device.generateKeys();
    const authSecret = randomBytes(16);
    const keys = { p256dh: device.getPublicKey().toString("base64url"), auth: authSecret.toString("base64url") };
    expect((await page.request.post("/api/push/subscribe", { data: { endpoint: push.url, keys } })).status()).toBe(200);

    // Lets the test put the app in the background, as switching apps or locking the phone does.
    await page.addInitScript(() => {
      let state: DocumentVisibilityState = "visible";
      Object.defineProperty(document, "visibilityState", { get: () => state });
      (window as unknown as { setHidden: (h: boolean) => void }).setHidden = (h) => {
        state = h ? "hidden" : "visible";
        document.dispatchEvent(new Event("visibilitychange"));
      };
    });
    await page.goto("/");
    await page.getByRole("button", { name: /Change model/ }).click();
    await page.getByRole("dialog", { name: "Choose a model" }).getByRole("button", { name: /Gemini 3\.8 Flash/ }).click();

    // Watched to the end: nothing.
    await page.getByLabel("Message Depeche").fill("Hello there");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("reply").last()).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });

    // Put away mid-answer: a notification once it's saved.
    await page.getByLabel("Message Depeche").fill("Say this slowly please");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("reply").last()).toHaveAttribute("aria-busy", "true");
    await page.evaluate(() => (window as unknown as { setHidden: (h: boolean) => void }).setHidden(true));
    await expect.poll(() => push.got.length, { timeout: 20_000 }).toBe(1);
    const note = JSON.parse(ece.decrypt(push.got[0].body, { version: "aes128gcm", privateKey: device, authSecret }).toString("utf8"));
    expect(note.url).toMatch(/^\/c\/[0-9a-f-]{36}$/);
    expect(page.url()).toContain(note.url);
    await page.evaluate(() => (window as unknown as { setHidden: (h: boolean) => void }).setHidden(false));

    // Put away and back before it finished: nothing more.
    await page.getByLabel("Message Depeche").fill("Say this slowly please, again");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("reply").last()).toHaveAttribute("aria-busy", "true");
    await page.evaluate(() => (window as unknown as { setHidden: (h: boolean) => void }).setHidden(true));
    await page.waitForTimeout(300);
    await page.evaluate(() => (window as unknown as { setHidden: (h: boolean) => void }).setHidden(false));
    await expect(page.getByTestId("reply").last()).not.toHaveAttribute("aria-busy", "true", { timeout: 20_000 });
    await page.waitForTimeout(1000);
    expect(push.got).toHaveLength(1);
  } finally {
    push.server.close();
  }
});

test("Account explains notifications for this device", async ({ page }, info) => {
  const errors = watchErrors(page);
  // Test Chrome always refuses notifications, so it acts as a fresh browser that hasn't been asked
  // yet, and as a person who then taps "Don't allow" on the prompt.
  if (info.project.name.startsWith("chrome")) {
    await page.addInitScript(() => {
      let permission: NotificationPermission = "default";
      Object.defineProperty(Notification, "permission", { get: () => permission });
      Notification.requestPermission = async () => (permission = "denied");
    });
  }
  await member(page, "Ola");
  await page.goto("/account");
  const section = page.locator("section", { has: page.getByRole("heading", { name: "Notifications" }) });
  await expect(section).toBeVisible();
  await expect(section.getByText("Checking this device…")).toHaveCount(0);
  if (info.project.name === "safari-iphone") {
    // iPhone Safari: the steps to add Depeche to the home screen, where notifications work.
    await expect(section.getByTestId("push-install")).toContainText("Add to Home Screen");
  } else if (info.project.name.startsWith("chrome")) {
    const toggle = section.getByRole("switch", { name: "Tell me when an answer is ready" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(section).toContainText("never what's in it");
    await toggle.click();
    await expect(section.getByTestId("push-blocked")).toContainText("allow notifications");
  } else {
    // Safari on a Mac supports web notifications directly.
    await expect(section.getByRole("switch", { name: "Tell me when an answer is ready" })).toBeVisible();
  }
  await section.screenshot({ path: info.outputPath("account-notifications.png") });
  // The notification worker loads for everyone, fresh every time.
  const sw = await page.request.get("/sw.js");
  expect(sw.headers()["content-type"]).toContain("javascript");
  expect(sw.headers()["cache-control"]).toContain("no-cache");
  expect(await sw.text()).toContain("showNotification");
  // Safari drops the header links' page prefetches when the test ends; that isn't a fault.
  expect(errors.filter((e) => !/access control checks/.test(e))).toEqual([]);
});
