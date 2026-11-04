import { expect, test, type Page } from "@playwright/test";
import { OWNER, signInWithPassword, watchErrors } from "./helpers";

/**
 * Voice: dictating into the box, hands-free voice chat and reading replies aloud. The microphone
 * is replaced by a tone (a "voice") followed by silence, made inside the page, so Chrome and
 * Safari both run the real recording, silence detection, upload and playback code. The server's
 * stand-in AI turns any recording into "What is the quadratic formula?" and speaks a short tone.
 */

/** Runs inside the page. Safe to run twice: the second time does nothing. */
function installFakes() {
  {
    const w = window as unknown as { __speech: number; __played: number; __fakes?: boolean };
    if (w.__fakes) return;
    w.__fakes = true;
    w.__speech = 0;
    w.__played = 0;
    const make = async (): Promise<MediaStream> => {
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
    // On the prototype, not navigator.mediaDevices itself: WebKit sometimes hands out a fresh
    // MediaDevices object, which would lose a patch made on the old one.
    MediaDevices.prototype.getUserMedia = make;
    // Count sounds played, to check replies are read aloud.
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
      if ((this.buffer?.length ?? 0) > 100) w.__played++;
      return start.apply(this, args);
    };
  }
}

async function fakeMicrophone(page: Page) {
  await page.addInitScript(installFakes);
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
  // WebKit sometimes skips init scripts on a navigation; make sure the fakes are in place.
  await page.evaluate(installFakes);
  // The voice buttons appear once the page is running, so typing before then isn't lost.
  await expect(page.getByRole("button", { name: "Voice chat" })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await fakeMicrophone(page);
  // The fake "voice" comes back every few seconds, which would talk over every answer; the
  // talking-over test turns this back on.
  await page.addInitScript(() => localStorage.setItem("depeche:voice-talk-over", "off"));
});

test("the mic writes what you said into the box", async ({ page }) => {
  const errors = watchErrors(page);
  await ready(page);
  await page.getByRole("button", { name: "Dictate" }).click();
  await expect(page.getByRole("button", { name: "Stop and write it out" })).toBeVisible();
  await page.waitForTimeout(3000);
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
  const calls: string[] = [];
  page.on("request", (r) => r.url().includes("/api/voice/") && calls.push(new URL(r.url()).pathname));
  await page.getByRole("button", { name: "Voice chat" }).click();
  const dialog = page.getByRole("dialog", { name: "Voice chat" });
  await expect(dialog).toBeVisible();
  // It hears the "speech", stops by itself after the pause, and sends it.
  // Captions: what you said, then the answer as it arrives.
  await expect(dialog.getByTestId("voice-you")).toHaveText("What is the quadratic formula?", { timeout: 15_000 });
  await expect(dialog.getByText("Speaking")).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByTestId("voice-answer")).toContainText("worked answer");
  await expect(dialog.getByTestId("voice-answer")).not.toContainText("$$");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __played: number }).__played), { timeout: 15_000 }).toBeGreaterThan(0);
  // Then it's your turn again: the microphone, let go of while the answer played, opens again.
  await expect(page.getByTestId("user-message")).toHaveCount(2, { timeout: 45_000 });
  expect(await page.evaluate(() => (window as unknown as { __speech: number }).__speech)).toBeGreaterThan(1);
  await dialog.getByRole("button", { name: "End voice chat" }).click();
  await expect(dialog).toHaveCount(0);
  // What was said and answered is in the chat like typed messages.
  await expect(page.getByTestId("user-message").last()).toHaveText("What is the quadratic formula?");
  await expect(page.getByTestId("reply").last()).toContainText("worked answer");
  expect(page.url()).toMatch(/\/c\/[0-9a-f-]{36}$/);
  // Heard live (no recording uploaded), and the live session's cost was settled on closing.
  expect(calls).toContain("/api/voice/live");
  expect(calls).not.toContain("/api/voice/listen");
  await expect.poll(() => calls.includes("/api/voice/live/done")).toBe(true);
  // Safari reports link prefetches it cancels; those aren't errors in the page.
  expect(errors.filter((e) => !/_rsc=.*access control checks/.test(e))).toEqual([]);
});

test("a reply can be read aloud and stopped", async ({ page }) => {
  await ready(page);
  await page.getByLabel("Message Depeche").fill("Read this one aloud");
  await page.getByRole("button", { name: "Send" }).click();
  const reply = page.getByTestId("reply").last();
  await expect(reply.getByRole("button", { name: "Copy reply" })).toBeVisible({ timeout: 15_000 });
  // A new chat's page can re-render once more just after the reply finishes (its address changes),
  // which can swallow a click made at that moment; click again if nothing started.
  const played = () => page.evaluate(() => (window as unknown as { __played: number }).__played);
  await expect(async () => {
    if (await reply.getByRole("button", { name: "Read aloud" }).isVisible()) await reply.getByRole("button", { name: "Read aloud" }).click();
    await expect.poll(played, { timeout: 5_000 }).toBeGreaterThan(0);
  }).toPass({ timeout: 30_000 });
  await expect(reply.getByRole("button", { name: "Stop reading" })).toBeVisible();
  await reply.getByRole("button", { name: "Stop reading" }).click();
  await expect(reply.getByRole("button", { name: "Read aloud" })).toBeVisible();
});

test("with the mic off, voice chat waits for a tap instead of locking", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Voice chat" }).click();
  const dialog = page.getByRole("dialog", { name: "Voice chat" });
  await expect(dialog.getByText("Listening")).toBeVisible();
  await dialog.getByRole("button", { name: "Mute" }).click();
  await expect(dialog.getByText("Mic off")).toBeVisible();
  // Mic off, nothing is heard or sent, even when the "voice" plays.
  await page.waitForTimeout(5000);
  await expect(dialog.getByTestId("voice-you")).toHaveCount(0);
  // A tap on the circle still lets you talk once, without turning the mic back on for good.
  await dialog.getByRole("button", { name: "Tap to talk" }).click();
  await expect(dialog.getByTestId("voice-you")).toHaveText("What is the quadratic formula?", { timeout: 15_000 });
  await expect(dialog.getByTestId("voice-answer")).toContainText("worked answer", { timeout: 15_000 });
  await expect(dialog.getByText("Mic off")).toBeVisible({ timeout: 45_000 });
  await dialog.getByRole("button", { name: "Unmute" }).click();
  await expect(dialog.getByText("Listening")).toBeVisible();
  await dialog.getByRole("button", { name: "End voice chat" }).click();
  await expect(dialog).toHaveCount(0);
});

test("with sound off, the answer shows as captions and nothing plays", async ({ page }) => {
  test.setTimeout(90_000);
  await ready(page);
  await page.getByRole("button", { name: "Voice chat" }).click();
  const dialog = page.getByRole("dialog", { name: "Voice chat" });
  await dialog.getByRole("button", { name: "Turn sound off" }).click();
  await expect(dialog.getByRole("button", { name: "Turn sound on" })).toBeVisible();
  await expect(dialog.getByTestId("voice-answer")).toContainText("worked answer", { timeout: 30_000 });
  // Your turn again once the answer is written, with nothing read aloud.
  await expect(page.getByTestId("user-message")).toHaveCount(2, { timeout: 45_000 });
  expect(await page.evaluate(() => (window as unknown as { __played: number }).__played)).toBe(0);
  await dialog.getByRole("button", { name: "End voice chat" }).click();
});

test("the languages you speak can be picked", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Voice chat" }).click();
  const dialog = page.getByRole("dialog", { name: "Voice chat" });
  // English, with Arabic and Urdu expected too, unless the person picks otherwise.
  await expect(dialog.getByRole("button", { name: "Languages: English + Arabic + Urdu" })).toBeVisible();
  await dialog.getByRole("button", { name: /^Languages:/ }).click();
  await dialog.getByRole("group", { name: "Languages you speak" }).getByRole("button", { name: "Arabic" }).click();
  await expect(dialog.getByRole("button", { name: "Languages: English + Urdu" })).toBeVisible();
  // The next turn listens for both languages.
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/voice/live") && r.headers()["x-languages"] === "en,ur");
  await expect(sent).resolves.toBeTruthy();
  await dialog.getByRole("button", { name: "End voice chat" }).click();
});

test("without live listening, voice chat records and writes out instead", async ({ page }) => {
  test.setTimeout(90_000);
  await ready(page);
  await page.route("**/api/voice/live", (r) => r.fulfill({ status: 404, json: { off: "Live listening needs a Google key." } }));
  const listened = page.waitForRequest((r) => r.url().endsWith("/api/voice/listen"));
  await page.getByRole("button", { name: "Voice chat" }).click();
  const dialog = page.getByRole("dialog", { name: "Voice chat" });
  await listened;
  await expect(dialog.getByTestId("voice-you")).toHaveText("What is the quadratic formula?", { timeout: 15_000 });
  await expect(dialog.getByTestId("voice-answer")).toContainText("worked answer", { timeout: 15_000 });
  await dialog.getByRole("button", { name: "End voice chat" }).click();
});

test("talking over the answer stops it and listens", async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => localStorage.setItem("depeche:voice-talk-over", "on"));
  let talkedOver = false;
  page.on("console", (m) => m.text().includes("talked over") && (talkedOver = true));
  await ready(page);
  await page.getByRole("button", { name: "Voice chat" }).click();
  const dialog = page.getByRole("dialog", { name: "Voice chat" });
  await expect(dialog.getByRole("button", { name: "Talk over answers: on" })).toBeVisible();
  await expect(dialog.getByTestId("voice-you")).toHaveText("What is the quadratic formula?", { timeout: 15_000 });
  // The fake voice comes back while the answer is being read, which cuts it off and is sent next.
  await expect.poll(() => talkedOver, { timeout: 30_000 }).toBe(true);
  await expect(page.getByTestId("user-message")).toHaveCount(2, { timeout: 30_000 });
  // It can be turned off, and stays off.
  await dialog.getByRole("button", { name: "Talk over answers: on" }).click();
  await expect(dialog.getByRole("button", { name: "Talk over answers: off" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("depeche:voice-talk-over"))).toBe("off");
  await dialog.getByRole("button", { name: "End voice chat" }).click();
});
