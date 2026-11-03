import { expect, test, type Page } from "@playwright/test";
import { OWNER, signInWithPassword, watchErrors } from "./helpers";

/**
 * Voice: dictating into the box, hands-free voice chat and reading replies aloud. The microphone
 * is replaced by a tone (a "voice") followed by silence, made inside the page, so Chrome and
 * Safari both run the real recording, silence detection, upload and playback code. The server's
 * stand-in AI turns any recording into "What is the quadratic formula?" and speaks a short tone.
 */

async function fakeMicrophone(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __speech: number; __played: number };
    w.__speech = 0;
    w.__played = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      // One context for the fake voice, like a real microphone's single device.
      const holder = window as unknown as { __micCtx?: AudioContext };
      const ctx = (holder.__micCtx ??= new Ctor());
      await ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 220;
      // Every four seconds: a second of "speech", then quiet.
      gain.gain.setValueAtTime(0, ctx.currentTime);
      for (let i = 0; i < 40; i++) {
        gain.gain.setValueAtTime(0.5, ctx.currentTime + i * 4 + 0.25);
        gain.gain.setValueAtTime(0, ctx.currentTime + i * 4 + 1.25);
      }
      const dest = ctx.createMediaStreamDestination();
      osc.connect(gain).connect(dest);
      osc.start();
      w.__speech++;
      const stream = dest.stream;
      const track = stream.getAudioTracks()[0];
      const stop = track.stop.bind(track);
      track.stop = () => {
        stop();
        osc.stop();
      };
      return stream;
    };
    // Count sounds played, to check replies are read aloud.
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
      if ((this.buffer?.length ?? 0) > 100) w.__played++;
      return start.apply(this, args);
    };
  });
}

async function ready(page: Page) {
  await signInWithPassword(page, OWNER.email, OWNER.password);
  await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
  // The chat tests add a Google test key; make sure there is one.
  await page.goto("/family");
  const row = page.getByTestId("provider-google");
  await expect(row.getByText(/Not added|ends in/)).toBeVisible();
  if (await row.getByText("Not added").isVisible()) {
    await row.getByLabel("Google (Gemini) API key").fill("test-google-key-1234567890abcd");
    await row.getByRole("button", { name: "Save key" }).click();
    await expect(row.getByText(/ends in/)).toBeVisible();
  }
  await page.goto("/");
}

test.beforeEach(async ({ page }) => {
  await fakeMicrophone(page);
});

test("the mic writes what you said into the box", async ({ page }) => {
  const errors = watchErrors(page);
  await ready(page);
  await page.getByRole("button", { name: "Dictate" }).click();
  await expect(page.getByRole("button", { name: "Stop and write it out" })).toBeVisible();
  await page.waitForTimeout(1600);
  await page.getByRole("button", { name: "Stop and write it out" }).click();
  await expect(page.getByLabel("Message Depeche")).toHaveValue("What is the quadratic formula?");
  // With text in the box, the round button sends again.
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  // Safari reports link prefetches it cancels; those aren't errors in the page.
  expect(errors.filter((e) => !/_rsc=.*access control checks/.test(e))).toEqual([]);
});

test("voice chat listens, sends, reads the reply aloud and listens again", async ({ page }, info) => {
  test.setTimeout(90_000);
  const errors = watchErrors(page);
  page.on("console", (m) => m.text().includes("[voice]") && console.log(info.project.name, m.text()));
  await ready(page);
  await page.getByRole("button", { name: "Voice chat" }).click();
  const dialog = page.getByRole("dialog", { name: "Voice chat" });
  await expect(dialog).toBeVisible();
  // It hears the "speech", stops by itself after the pause, and sends it.
  await expect(dialog.getByText("“What is the quadratic formula?”")).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByText("Speaking")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __played: number }).__played)).toBeGreaterThan(0);
  // Then it's your turn again: it listens and sends a second message, on the same microphone.
  await expect(page.getByTestId("user-message")).toHaveCount(2, { timeout: 45_000 });
  expect(await page.evaluate(() => (window as unknown as { __speech: number }).__speech)).toBe(1);
  await dialog.getByRole("button", { name: "End", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // What was said and answered is in the chat like typed messages.
  await expect(page.getByTestId("user-message").last()).toHaveText("What is the quadratic formula?");
  await expect(page.getByTestId("reply").last()).toContainText("worked answer");
  expect(page.url()).toMatch(/\/c\/[0-9a-f-]{36}$/);
  // Safari reports link prefetches it cancels; those aren't errors in the page.
  expect(errors.filter((e) => !/_rsc=.*access control checks/.test(e))).toEqual([]);
});

test("a reply can be read aloud and stopped", async ({ page }) => {
  await ready(page);
  await page.getByLabel("Message Depeche").fill("Read this one aloud");
  await page.getByRole("button", { name: "Send" }).click();
  const reply = page.getByTestId("reply").last();
  await expect(reply.getByRole("button", { name: "Copy reply" })).toBeVisible({ timeout: 15_000 });
  await reply.getByRole("button", { name: "Read aloud" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __played: number }).__played)).toBeGreaterThan(0);
  await expect(reply.getByRole("button", { name: "Stop reading" })).toBeVisible();
  await reply.getByRole("button", { name: "Stop reading" }).click();
  await expect(reply.getByRole("button", { name: "Read aloud" })).toBeVisible();
});
