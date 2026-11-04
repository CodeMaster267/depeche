import { expect, test, type Page } from "@playwright/test";
import { OWNER, admin, signInWithPassword, uniqueEmail } from "./helpers";

/** The family needs a Google key for Gemini; the owner adds a test key if it's missing. */
async function familyHasGoogleKey(page: Page) {
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
  await page.context().clearCookies();
}

/** Selects the words `text` inside the newest answer, the way a person dragging over them would. */
async function selectInReply(page: Page, text: string) {
  await page.getByTestId("reply").last().evaluate((reply, wanted) => {
    const walker = document.createTreeWalker(reply, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = n.textContent?.indexOf(wanted) ?? -1;
      if (at < 0) continue;
      n.parentElement?.scrollIntoView({ block: "center" });
      const range = document.createRange();
      range.setStart(n, at);
      range.setEnd(n, at + wanted.length);
      const sel = document.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    throw new Error(`"${wanted}" isn't in the reply`);
  }, text);
}

test("answers suggest follow-ups, show their cost, and parts of them can be asked about", async ({ page }) => {
  await familyHasGoogleKey(page);
  const db = admin();
  const email = uniqueEmail("extras");
  const { data: user } = await db.auth.admin.createUser({ email, password: "member-password-123", email_confirm: true });
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  await db.from("profiles").insert({ id: user.user!.id, family_id: owner!.family_id, display_name: "Noor" });

  await signInWithPassword(page, email, "member-password-123");
  await expect(page.getByRole("heading", { name: "Hi, Noor." })).toBeVisible();
  await page.getByRole("button", { name: /Change model/ }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a model" });
  await dialog.getByRole("button", { name: /Gemini 3\.8 Flash/ }).click();
  await expect(dialog).toHaveCount(0);

  // Follow-ups: offered as buttons under the answer, never as text in it.
  await page.getByLabel("Message Depeche").fill("Give me next steps for this formula");
  await page.getByRole("button", { name: "Send" }).click();
  const first = page.getByTestId("reply").last();
  await expect(first).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
  await expect(first).not.toContainText("<followups>");
  const chips = first.getByTestId("followups");
  await expect(chips.getByRole("button")).toHaveText(["How do I check the answer?", "What if a is zero?"]);

  // Cost: tap it to see the tokens behind the number.
  await first.getByTestId("message-cost").click();
  const details = page.getByTestId("cost-details");
  await expect(details).toContainText("1,200 tokens");
  await expect(details).toContainText("400 tokens");
  await page.getByRole("button", { name: "Close" }).first().click();
  await expect(details).toHaveCount(0);

  // Kept with the answer, so they're still offered after a reload.
  const chatId = new URL(page.url()).pathname.split("/").pop()!;
  const { data: saved } = await db.from("messages").select("content").eq("chat_id", chatId).eq("role", "assistant").single();
  expect(saved!.content.followups).toEqual(["How do I check the answer?", "What if a is zero?"]);
  expect(saved!.content.usage).toEqual({ input: 1200, output: 400 });

  // Tapping one asks it.
  await chips.getByRole("button", { name: "What if a is zero?" }).click();
  await expect(page.getByTestId("user-message").last()).toHaveText("What if a is zero?");
  const second = page.getByTestId("reply").last();
  await expect(second).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
  // Only the newest answer has follow-ups, and this one had none.
  await expect(page.getByTestId("followups")).toHaveCount(0);

  // A selected part can be dropped before sending.
  await selectInReply(page, "This is well documented");
  await page.getByTestId("ask-about-selection").click();
  await expect(page.getByTestId("quote-chip")).toContainText("This is well documented");
  await page.getByRole("button", { name: "Don't ask about this" }).click();
  await expect(page.getByTestId("quote-chip")).toHaveCount(0);

  // Ask about a selected part of the answer.
  await selectInReply(page, "The quadratic formula solves");
  await page.getByTestId("ask-about-selection").click();
  await expect(page.getByTestId("quote-chip")).toContainText("The quadratic formula solves");
  await expect(page.getByLabel("Message Depeche")).toBeFocused();
  await page.getByLabel("Message Depeche").fill("Say that more simply");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("quote-chip")).toHaveCount(0);
  const third = page.getByTestId("reply").last();
  await expect(third).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
  // The model was given the selected part along with the question.
  await expect(third).toContainText('You asked about "The quadratic formula solves"');
  await expect(page.getByTestId("message-quote")).toHaveCount(1);
  await expect(page.getByTestId("message-quote")).toHaveText(/The quadratic formula solves/);

  // Editing the question keeps what it was asking about.
  await page.getByTestId("user-message").last().hover();
  await page.getByRole("button", { name: "Edit message" }).last().click();
  await page.getByLabel("Edit your message").fill("Say that even more simply");
  await page.getByRole("button", { name: "Send", exact: true }).first().click();
  await expect(page.getByTestId("user-message").last()).toHaveText("Say that even more simply");
  const edited = page.getByTestId("reply").last();
  await expect(edited).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
  await expect(edited).toContainText('You asked about "The quadratic formula solves"');
  await expect(page.getByTestId("message-quote")).toHaveCount(1);
  const { data: asked } = await db.from("messages").select("content").eq("chat_id", chatId).eq("role", "user").like("content->>text", "%even more%").single();
  expect(asked!.content.quote).toBe("The quadratic formula solves");

  // The quote stays with the question after a reload.
  await page.reload();
  await expect(page.getByTestId("message-quote")).toHaveText(/The quadratic formula solves/);
});
