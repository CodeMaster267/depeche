import { expect, test, type Browser, type Page } from "@playwright/test";
import { OWNER, admin, noSidewaysScroll, signInWithPassword, uniqueEmail, watchErrors } from "./helpers";

/**
 * Projects: folders of chats with their own instructions and files. The stand-in AI repeats the
 * project instructions and file names it was given when a message says "project".
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==",
  "base64",
);

/** The family needs a key before there's a model to chat with (test keys start with "test-"). */
async function ensureGoogleKey(browser: Browser) {
  const page = await browser.newPage();
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
  await page.close();
}

/** A member of their own with a few chats, so these tests never touch anyone else's list. */
async function member(page: Page, titles: string[], name = "Noor") {
  const db = admin();
  const email = uniqueEmail("projects");
  const { data: user } = await db.auth.admin.createUser({ email, password: "member-password-123", email_confirm: true });
  const id = user.user!.id;
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  await db.from("profiles").insert({ id, family_id: owner!.family_id, display_name: name });
  const now = Date.now();
  const { data: chats } = await db
    .from("chats")
    .insert(titles.map((title, i) => ({ owner_id: id, title, updated_at: new Date(now - i * 60_000).toISOString() })))
    .select("id, title");
  await signInWithPassword(page, email, "member-password-123");
  await expect(page.getByRole("heading", { name: `Hi, ${name}.` })).toBeVisible();
  return { db, id, chats: Object.fromEntries((chats ?? []).map((c) => [c.title, c.id as string])) };
}

const phone = (page: Page) => (page.viewportSize()?.width ?? 1000) < 768;

async function chatList(page: Page) {
  if (phone(page)) await page.getByRole("button", { name: "Open menu" }).click();
  const nav = page.getByRole("navigation", { name: "Chats" }).filter({ visible: true });
  await expect(nav).toBeVisible();
  return nav;
}

async function closeList(page: Page) {
  if (phone(page)) await page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: "Close menu" }).click();
}

test("make a project with instructions and files, chat in it, and move chats in and out", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await ensureGoogleKey(browser);
  const errors = watchErrors(page);
  const { db, id, chats } = await member(page, ["Titration notes", "Holiday plan"]);

  // Make it from the chat list.
  let list = await chatList(page);
  await list.getByRole("button", { name: "New project" }).click();
  const sheet = page.getByRole("dialog", { name: "New project" });
  await sheet.getByLabel("Project name").fill("  Chemistry   revision ");
  await sheet.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/p\/[0-9a-f-]{36}$/);
  const projectId = page.url().split("/p/")[1];
  const panel = page.getByTestId("project");
  await expect(panel.getByRole("heading", { name: "Chemistry revision" })).toBeVisible();
  await noSidewaysScroll(page);

  // Instructions.
  await panel.getByRole("region", { name: "Instructions" }).getByRole("button", { name: "Add" }).click();
  const instr = page.getByRole("dialog", { name: "Project instructions" });
  await instr.getByLabel("Instructions").fill("Answer like a patient tutor.");
  await instr.getByRole("button", { name: "Save" }).click();
  await expect(instr).toHaveCount(0);
  await expect(page.getByTestId("project-instructions")).toHaveText("Answer like a patient tutor.");

  // Files: a text file and a photo; something Depeche can't read is refused.
  await page.getByTestId("project-file-input").setInputFiles([
    { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Acids\nAcids donate protons.") },
    { name: "dot.png", mimeType: "image/png", buffer: PNG },
    { name: "song.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("no") },
  ]);
  await expect(page.getByTestId("project-file")).toHaveCount(2);
  await expect(panel.getByText("Can't send this kind of file")).toBeVisible();
  await expect.poll(async () => (await db.from("project_files").select("name").eq("owner_id", id).order("name")).data?.map((f) => f.name)).toEqual([
    "dot.png",
    "notes.md",
  ]);

  // Still there after a reload.
  await page.reload();
  await expect(page.getByTestId("project-file")).toHaveCount(2);
  await expect(page.getByTestId("project-instructions")).toHaveText("Answer like a patient tutor.");

  // A chat started here is in the project, and the model gets the instructions and files.
  await expect(page.getByLabel("Message Depeche")).toHaveAttribute("placeholder", "New chat in Chemistry revision");
  await page.getByLabel("Message Depeche").fill("what does the project say");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);
  const reply = page.getByTestId("reply").last();
  await expect(reply).toContainText("Project instructions: Answer like a patient tutor.", { timeout: 30_000 });
  await expect(reply).toContainText("Project files: notes.md, dot.png");
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout: 30_000 });
  const started = page.url().split("/c/")[1];
  expect((await db.from("chats").select("project_id").eq("id", started).single()).data?.project_id).toBe(projectId);
  await expect(page.getByRole("banner").getByRole("link", { name: "Project: Chemistry revision" })).toBeVisible();

  // Writing again in the chat keeps using the project.
  await page.getByLabel("Message Depeche").fill("and the project again");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("reply").last()).toContainText("Project instructions: Answer like a patient tutor.", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout: 30_000 });

  // A project's chats are kept out of the main list.
  list = await chatList(page);
  await expect(list.getByRole("link", { name: "what does the project say" })).toHaveCount(0);
  await expect(list.getByRole("link", { name: "Chemistry revision" })).toBeVisible();

  // Move an older chat in from its three dots.
  await list.getByRole("button", { name: "Options for Titration notes" }).click();
  await page.getByRole("menuitem", { name: "Move to project" }).click();
  const move = page.getByRole("dialog", { name: "Move to project" });
  await move.getByRole("button", { name: "Chemistry revision" }).click();
  await expect(move).toHaveCount(0);
  await expect(list.getByRole("link", { name: "Titration notes" })).toHaveCount(0);
  await expect.poll(async () => (await db.from("chats").select("project_id").eq("id", chats["Titration notes"]).single()).data?.project_id).toBe(projectId);
  // Searching still finds it.
  await list.getByLabel("Search chats").fill("titration");
  await expect(list.getByRole("link", { name: "Titration notes" })).toBeVisible();
  await list.getByLabel("Search chats").fill("");

  // The project lists both, and one can be taken back out from there.
  await list.getByRole("link", { name: "Chemistry revision" }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${projectId}$`));
  const inProject = page.getByRole("region", { name: "Chats in this project" });
  await expect(inProject.getByRole("link")).toHaveText(["what does the project say", "Titration notes"]);
  await inProject.getByRole("button", { name: "Options for Titration notes" }).click();
  await page.getByRole("menuitem", { name: "Move to another project" }).click();
  await page.getByRole("dialog", { name: "Move to project" }).getByRole("button", { name: "Take out of project" }).click();
  await expect(inProject.getByRole("link")).toHaveText(["what does the project say"]);
  await expect.poll(async () => (await db.from("chats").select("project_id").eq("id", chats["Titration notes"]).single()).data?.project_id).toBeNull();

  // A new project made straight from the move sheet.
  await page.goto(`/c/${chats["Holiday plan"]}`);
  await page.getByRole("button", { name: "Chat options" }).click();
  await page.getByRole("menuitem", { name: "Move to project" }).click();
  await page.getByRole("dialog", { name: "Move to project" }).getByRole("button", { name: "New project" }).click();
  await page.getByRole("dialog", { name: "Move to project" }).getByLabel("Project name").fill("Travel");
  await page.getByRole("dialog", { name: "Move to project" }).getByRole("button", { name: "Create and move" }).click();
  await expect(page.getByRole("banner").getByRole("link", { name: "Project: Travel" })).toBeVisible();
  await expect.poll(async () => (await db.from("projects").select("name").eq("owner_id", id).order("name")).data?.map((p) => p.name)).toEqual([
    "Chemistry revision",
    "Travel",
  ]);
  await noSidewaysScroll(page);
  await closeList(page).catch(() => {});
  expect(errors).toEqual([]);
});

test("a project is private, and deleting it keeps its chats", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { db, id, chats } = await member(page, ["Wedding guest list"], "Zara");
  const { data: project } = await db.from("projects").insert({ owner_id: id, name: "Wedding", instructions: "Secret plans" }).select("id").single();
  await db.from("chats").update({ project_id: project!.id }).eq("id", chats["Wedding guest list"]);

  // Someone else in the family (even the admin) can't open it.
  const other = await browser.newPage();
  await signInWithPassword(other, OWNER.email, OWNER.password);
  await expect(other.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
  await other.goto(`/p/${project!.id}`);
  await expect(other.getByText(/could not be found|404/i).first()).toBeVisible();
  await expect(other.getByText("Secret plans")).toHaveCount(0);
  // Nor start a chat inside it to get its instructions.
  const sent = await other.request.post("/api/chat", {
    data: { projectId: project!.id, text: "what does the project say", model: "gemini-3.8-flash", clientRequestId: crypto.randomUUID() },
  });
  expect(sent.status()).toBe(404);
  await other.close();

  // Its owner can, and deleting it moves the chat back to the main list.
  await page.goto(`/p/${project!.id}`);
  await expect(page.getByTestId("project-instructions")).toHaveText("Secret plans");
  await page.getByRole("button", { name: "Delete project" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete project" });
  await expect(confirm).toContainText("Its chats are kept");
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/$/);
  const list = await chatList(page);
  await expect(list.getByRole("link", { name: "Wedding guest list" })).toBeVisible();
  await expect(list.getByRole("link", { name: "Wedding", exact: true })).toHaveCount(0);
  expect((await db.from("projects").select("id").eq("owner_id", id)).data).toEqual([]);
  expect((await db.from("chats").select("project_id").eq("id", chats["Wedding guest list"]).single()).data?.project_id).toBeNull();
  expect(errors).toEqual([]);
});
