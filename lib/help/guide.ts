import { MODELS, PROVIDERS, PROVIDER_NAME, canSearch, isImageModel } from "@/lib/ai/models";

/**
 * Concierge's knowledge: what every part of Depeche does and exactly where to tap. It is written
 * for people, not code, and kept in the repo so it changes with the app.
 *
 * KEEP IT CURRENT. When you add, rename or move anything people can see, update the topic it
 * belongs to (or add one). `tests/help/guide.test.ts` fails when a page, a settings section, a
 * sidebar link or a chat-menu item isn't mentioned here, and CI's "Concierge guide" check fails
 * when a pull request adds new screens or components without touching this file.
 *
 * Links: write in-app links as Markdown with a path, like [Family → AI providers](/family#ai-providers).
 * Every settings section can be linked by its title in lower case with dashes (see `slug` in
 * components/AppHeader.tsx). Concierge shows these as tappable links.
 *
 * The model list, providers and key hints are not written here: `modelsTopic()` builds them from
 * lib/ai/models.ts, so they are always right.
 */
export type Topic = {
  id: string;
  title: string;
  /** The pages this topic explains. Every page in app/ must be covered by some topic. */
  routes?: string[];
  /** Only admins see this part of Depeche. Concierge still answers members, but says so. */
  admin?: boolean;
  text: string;
};

export const TOPICS: Topic[] = [
  {
    id: "about",
    title: "What Depeche is",
    routes: ["/"],
    text: `
Depeche is a private AI chat app for a few families and friends, run by Hasan. Each family shares its own AI keys
(Anthropic for Claude, OpenAI for GPT, Google for Gemini, DeepSeek, xAI for Grok), and each person has their own private
chats. Only you can read your chats, memories and instructions. A family admin sees how much each member spends and,
only if the member chooses, their chat titles; never what anyone writes. Hasan, as the app's owner, sees nothing inside
another family. Each message goes only to the AI company whose model you picked.

The home screen is a new chat. On a phone, tap the menu button (three lines, top left) to open the side menu with your
chats; on a computer the side menu is always on the left. At the bottom of the side menu is your name with links to
Family and Health (admins only), Memory, Account, My look and Report a bug, and a bar showing what you have
spent this month against your limit. "Ask Concierge", under your chats, opens this helper.`,
  },
  {
    id: "chatting",
    title: "Chatting",
    routes: ["/c/[id]"],
    text: `
- Start a new chat: "New chat" at the top of the side menu, or the round new-chat button at the top right of a chat.
- Type in the box at the bottom ("Message Depeche") and tap the arrow to send. On a computer Enter sends and
  Shift+Enter makes a new line; on a phone Enter makes a new line. Tap the square to stop a reply.
- Change the model: tap the model's name at the top of the chat. The picker lists the models your family has keys for,
  with a search box. You can switch models halfway through a chat.
- Under each reply: copy, try again (answers the same message again; earlier answers are kept and you can flip between
  them with the arrows), view the Markdown source, and the cost. Tap the cost to see the tokens it used, how many were
  reused from the cache, and any web searches.
- Edit something you sent: tap the pencil under your message. The original is kept; arrows let you switch versions.
- Ask about part of an answer: select some text in a reply and tap "Ask about this". Your next message is about that bit.
- Follow-up suggestions sometimes appear as buttons under a reply; tap one to send it.
- A reply can suggest something to remember about you. It is only kept if you tap "Remember".
- Replies can include tables, maths, code, diagrams and charts. Code blocks have a copy button.
- If a model is busy, Depeche retries and may let a lighter model from the same company answer, and says so.`,
  },
  {
    id: "composer",
    title: "Attaching files, web search, deep research",
    text: `
The buttons next to the message box:
- Paperclip ("Attach photos or files"): photos, PDFs, Word, Excel, PowerPoint, and text or code files. Up to 5 files a
  message and 10 MB each. You can also paste or drag files in. Word, Excel and PowerPoint files are read by Depeche and
  sent as text; photos and PDFs go to the model as they are. Uploaded files are deleted after 3 days without use.
- Globe ("Search the web"): when it's on, the model searches the web when it needs to and shows its sources. Each search
  has a small fee. DeepSeek models can't search, so the globe is greyed out for them.
- Deep research (the magnifier with lines): for this one message, the model runs several web searches and writes a long
  report with sources. It takes a few minutes and costs more than a normal reply; progress shows in the chat.
- Microphone: see Voice.`,
  },
  {
    id: "files-out",
    title: "Making files, charts and canvas",
    text: `
- Ask for a document and the model can make a file you download from the reply: Word (.docx), PDF, Excel (.xlsx), CSV,
  Markdown, text or JSON. Tap the file card in the reply to download it.
- Charts: ask for a chart and it is drawn in the reply. Upload a CSV or Excel file and ask questions about it; the
  numbers are worked out with Python that runs safely inside your browser.
- Canvas: when you ask for a long document or code to work on, the model writes it in a canvas that opens beside the
  chat (full screen on a phone). You can edit it yourself, ask the model to change it, go back to older versions with
  the arrows, copy it, or download it (Word, PDF or a code file). Close it with the X; reopen it with the canvas button at
  the top of the chat.`,
  },
  {
    id: "pictures",
    title: "Making and editing pictures",
    text: `
Tap the model name at the top of a chat; the picker has a "Make pictures" section (only if your family has a key that
can make pictures: OpenAI's GPT Image, Google's Nano Banana on a paid Google key, or xAI's Grok Imagine). Pick one and
describe the picture. To edit a picture, attach it (or pick a picture model in a chat that has one) and describe what to
change. Pictures cost more than text (a few cents each). On a phone, press and hold or use the share sheet
to save it to Photos.`,
  },
  {
    id: "compare",
    title: "Comparing models side by side",
    text: `
Tap the model name at the top of a chat, then "Ask several models at once". Pick 2 or 3 models and tap "Compare N
models". Your next messages are answered by each of them side by side (swipe between answers on a phone). Each answer
costs what that model costs. Open the picker again and pick one model to go back to a single answer.`,
  },
  {
    id: "voice",
    title: "Voice",
    text: `
Voice needs your family to have a Google or OpenAI key (Claude has no voice).
- Dictate: tap the microphone next to the message box, talk, tap again, and what you said is written into the box.
- Voice chat: when the box is empty the send button becomes a voice button. Talk hands-free; Depeche listens, answers
  out loud, then listens again. Tap the circle to interrupt; tap End to finish. Everything is saved in the chat as text.
  You can pick the languages you speak (for example English and Urdu mixed) so it understands you.
- Read aloud: the speaker button under a reply reads it to you.
Voice works while the app is open; iPhones don't let websites listen in the background.`,
  },
  {
    id: "chat-list",
    title: "Your chat list: search, pin, archive, delete",
    text: `
- The side menu lists your chats: Pinned, Today, Yesterday, Previous 7 days, Earlier. The Search box there filters by title.
- Each chat has three dots (in the list, and at the top right of an open chat) with: Rename, Pin (or Unpin), Archive
  (or Restore), Download (the chat as a file) and Delete.
- "Archived chats" at the bottom of the list shows chats you put away. Writing in an archived chat brings it back.
- Chats you haven't used for a month are deleted with their files, archived ones too. Pinned chats are always kept. To
  keep everything, turn on "Keep all my chats" in [Account → Old chats](/account#old-chats). When chats are about to be
  deleted, a line at the top of the chat screen says so, with "Keep" to save them.`,
  },
  {
    id: "skills",
    title: "Skills",
    routes: ["/skills", "/skills/[id]"],
    text: `
[Skills](/skills) (side menu → Skills) teach Depeche how to help with one kind of task, like a family budget or planning a
wedding. Add a skill to "My skills" and your chats pick it up by themselves whenever a message is about it (or names it).
- Make a skill: describe what it should help with; a model writes it and names it. Every skill is checked for safety
  and goes in the Library for everyone on Depeche.
- Library: search everyone's skills and tap Add (or Remove) to choose which are yours.
- Tap a skill to see its Instructions, any Files, and "Picked up when a message mentions" (the words that trigger it).
  If you made it, "Change this skill" lets you ask for changes or edit it yourself, and Delete takes it out of the
  library. Admins can remove a skill from the library.
Skills never see your memories or other chats.`,
  },
  {
    id: "caching",
    title: "Prompt caching",
    text: `
Prompt caching makes long chats cheaper. When you send a message, the whole conversation so far goes to the model
again. With caching, the AI company keeps the start of the conversation for a few minutes, and re-reading it costs a
small fraction of the normal price (often a tenth or less).
- You don't need to switch anything on. Depeche turns it on for Claude chats, and OpenAI, Gemini, DeepSeek and Grok do
  it by themselves.
- It helps most when you keep replying in the same chat within a few minutes (Claude keeps the cache about 5 minutes,
  OpenAI about 30). After a long pause the next message costs the normal price once.
- To see it: tap the cost under a reply. "Of that, reused" shows how many tokens came from the cache.
- Writing to Claude's or GPT's cache costs a little extra the first time, which is paid back by the next message.`,
  },
  {
    id: "memory",
    title: "Memory and personal instructions",
    routes: ["/memory"],
    text: `
[Memory](/memory) (side menu → Memory) is what Depeche knows about you and how you like answers, used in every chat with
every model. Only you can see it; your family admin can't.
- Personal instructions: "About you" and "How should Depeche answer". Tap "Save instructions". Turn them off to pause
  them without deleting what you wrote.
- Remembered: things you asked Depeche to remember. Remove any one with its X.
- Teach Depeche: type a fact and tap "Remember" to add it yourself.
- Start over: forget everything remembered at once.
Replies sometimes suggest something to remember; nothing is kept unless you tap Remember.`,
  },
  {
    id: "account",
    title: "Account settings",
    routes: ["/account", "/new-password"],
    text: `
[Account](/account) (side menu → Account) has, from top to bottom:
- Sign out (top right).
- You: your name and username (a username lets you sign in without typing your email).
- Password: set one to sign in with your username or email and a password. Forgot it? Your family admin can give you a
  temporary one, and then Depeche asks you to choose a new password first.
- Notifications: "Tell me when an answer is ready" sends a notification when a reply finishes after you left the app.
  On iPhone and iPad this only works in the home-screen app: in Safari tap Share, then "Add to Home Screen", open
  Depeche from there, then turn it on.
- App lock: a PIN, plus Face ID or Touch ID, to open Depeche (see App lock).
- My look: link to redesign your Depeche.
- Old chats: "Keep all my chats" stops the one-month auto-delete.
- Privacy: who sees what, and a switch to share your chat titles (never contents) with your family admin.
- Devices: "Sign out everywhere".
- Changes made to your account: anything an admin changed for you.
- Your data: download a zip of all your chats, memories, files, spending and settings.
- Bring in old chats: import your ChatGPT, Claude or Gemini export (see Importing).
- Delete: permanently delete all your chats, memories and instructions (type delete to confirm).
- Something broken?: link to Report a bug.`,
  },
  {
    id: "lock",
    title: "App lock (PIN, Face ID, Touch ID)",
    routes: ["/lock"],
    text: `
Turn it on in [Account → App lock](/account#app-lock): tap "Turn on app lock", choose a PIN of 4 to 8 digits, then add
Face ID or Touch ID on each device if it offers it. Choose when it locks: as soon as you leave Depeche, or after 1, 5 or
15 minutes, or 1 hour. "Lock Depeche" locks it now. Forgot the PIN? Sign out and back in on the lock screen, then choose
a new PIN in Account. "Turn off app lock" turns it off on all your devices.`,
  },
  {
    id: "look",
    title: "My look (redesign your Depeche)",
    routes: ["/design"],
    text: `
[My look](/design) (side menu → My look, or Account → My look) lets you redesign your own Depeche: colours, fonts,
layout, buttons and shortcuts. Describe the look you want and tap the button to build it; the strongest model your family
has designs it. You see a preview and choose Keep or Undo. Only you see it. Earlier looks are listed so you can go back
to any of them for free. You get a set number of builds a month (your admin sets it); a failed build doesn't count.
If a look ever makes Depeche hard to use, Safe mode (on the My look page) shows standard Depeche again.`,
  },
  {
    id: "spending",
    title: "Spending and limits",
    text: `
Each person has a monthly spending limit in dollars, set by their family admin. The bar at the bottom of the side menu
shows what you've spent this month and your limit. Tap the cost under any reply to see its tokens. When you reach the
limit, Depeche stops sending until next month or until your admin raises it. Costs are estimates from token counts;
each AI company's own bill is the final word. Cheaper models (marked $ in the picker) make your limit last longer.`,
  },
  {
    id: "import-export",
    title: "Importing and exporting chats",
    text: `
- Import: [Account → Bring in old chats](/account#bring-in-old-chats). Get your export first: ChatGPT: Settings, Data
  controls, Export data. Claude: Settings, Privacy, Export data. Open the email, download the zip, and pick it here as it
  is (no need to unzip). The chats become your own private chats.
- Export everything: [Account → Your data](/account#your-data).
- Export one chat: its three dots → Download.`,
  },
  {
    id: "family",
    title: "Family settings",
    routes: ["/family"],
    admin: true,
    text: `
[Family](/family) (side menu → Family; admins only) has:
- AI providers: where API keys go. Each row is one company. To add a key: open the company's key page (the link in its
  row), create a key, copy it, paste it into the row, and tap "Save key". Depeche checks it, encrypts it, and shows only
  its last 4 characters from then on; it lists which models that key can use. "Replace" swaps it for a new key, "Remove"
  deletes it. Everyone in the family then sees those models in the picker.
- Members: tap a person to set their monthly limit (then "Save limit"), see the chat titles they chose to share, give
  them a temporary password, sign them out everywhere, or make them backup admin ("Make backup admin"; a family can
  have two admins). You can also step down as admin.
- Designs: "Manage designs" sets how many look builds each person gets a month and can switch designs off.
- Invite someone: their name and email, then "Create invite link" and "Copy link". Send the link only to them; it
  expires after a while, and pending invites can be cancelled.
- Admin log: every change an admin makes. Members see the entries about themselves in Account.
- Other families (Hasan only): create a family and invite its first admin.`,
  },
  {
    id: "family-designs",
    title: "Managing designs for the family",
    routes: ["/family/designs"],
    admin: true,
    text: `
[Family → Designs → Manage designs](/family/designs):
- Switch and builds: turn "Let people redesign their Depeche" on or off (off shows everyone standard Depeche straight
  away) and set "Builds per person each month" for the family.
- People: how many builds each person has used, a different allowance for one person, and "Design a look for" them
  (the look is offered to them to keep or not).
- Couldn't do yet: requests the designer couldn't fully do, or turned down as not family friendly.
- Activity: every build, who asked and what it cost.`,
  },
  {
    id: "health",
    title: "Health",
    routes: ["/health"],
    admin: true,
    text: `
[Health](/health) (side menu → Health; admins only) shows whether anything needs attention: each AI key and how its
replies went in the last day, family spending this month against everyone's limits, and backups. Hasan also sees the
System section and "Database and sync" (whether the database answers and when it last synced). Counts and dates only, never what anyone wrote.`,
  },
  {
    id: "report",
    title: "Reporting a bug",
    routes: ["/report"],
    text: `
Side menu → Report a bug, or [Account → Something broken?](/report). Say what happened and what you expected. You can
send 3 a day. Your reports and where each one is (Sent, Being fixed, Fixed…) are listed on the same page. Claude reads new
reports daily and fixes real bugs; Hasan checks anything uncertain.`,
  },
  {
    id: "sign-in",
    title: "Signing in and joining",
    routes: ["/sign-in", "/invite/[token]", "/setup"],
    text: `
Depeche is invite-only: there is no sign-up. Your family admin sends you an invite link; open it to join. To sign in
([sign-in page](/sign-in)) use your email (Depeche emails you a link and a 6-digit code; type the code if the link opens
in the wrong browser, which is common in the iPhone home-screen app), your username or email with a password if you set
one, or Google. You can be signed in on several devices. Hasan set up Depeche once at /setup.

Install it like an app: on iPhone or iPad, open Depeche in Safari, tap Share, then "Add to Home Screen". On Android,
Chrome's menu → "Add to Home screen" or "Install app".`,
  },
  {
    id: "concierge",
    title: "Concierge (this helper)",
    routes: ["/help"],
    text: `
Concierge answers questions about using Depeche. Open it from "Ask Concierge" in the side menu (under your chats, with a little bell), or the round bell button at
the top right of settings pages like Account and Memory (on an admin's phone, only the side menu). It knows Depeche's features and your role and your family's keys, but not your chats or memories. It
uses Claude Haiku when your family has a Claude key, otherwise another cheap model, and counts toward your monthly limit
like a chat (usually a fraction of a cent a question). The conversation isn't saved; it clears when you close the tab.`,
  },
];

/** The models and keys section, built from the live model list so it is never out of date. */
export function modelsTopic(): Topic {
  const lines = PROVIDERS.map((p) => {
    const models = MODELS.filter((m) => m.provider === p.id);
    const chat = models.filter((m) => !isImageModel(m)).map((m) => `${m.name} (${m.tags.join(", ")}; $${m.price.input} in / $${m.price.output} out per million tokens${canSearch(m) ? "" : "; no web search"})`);
    const pics = models.filter(isImageModel).map((m) => m.name);
    return `- ${p.name}. Key: ${p.keyUrl} (${p.keyHint}). Chat models: ${chat.join("; ") || "none"}.${pics.length ? ` Picture models: ${pics.join(", ")}.` : ""}`;
  });
  return {
    id: "models",
    title: "Models and AI keys",
    text: `
Depeche works with these AI companies (${PROVIDERS.map((p) => PROVIDER_NAME[p.id]).join(", ")}). A model shows up only once
the family admin has added that company's key in [Family → AI providers](/family#ai-providers).
Prices are what the company charges per million tokens (about 750,000 words); a typical short question and answer is a
fraction of a cent on cheap models.
${lines.join("\n")}`,
  };
}

/** Every topic, in order, with the live model list. */
export function allTopics(): Topic[] {
  return [...TOPICS.slice(0, 1), modelsTopic(), ...TOPICS.slice(1)];
}

/** The whole guide as Markdown, for Concierge's instructions. */
export function guideText(): string {
  return allTopics()
    .map((t) => `## ${t.title}${t.admin ? " (admins only)" : ""}\n${t.text.trim()}`)
    .join("\n\n");
}
