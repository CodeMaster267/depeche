import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { MODELS, PROVIDERS } from "@/lib/ai/models";
import { allTopics, guideText } from "@/lib/help/guide";
import { CONCIERGE_MODELS, conciergeModels, conciergeSystem, personalLines, type HelpContext } from "@/lib/help/concierge";

/**
 * Concierge answers from lib/help/guide.ts, so the guide must keep up with the app. These checks
 * fail when something people can see is added or renamed without the guide saying where it is.
 * The fix is almost always to add a line to the right topic in lib/help/guide.ts.
 */

const ROOT = join(__dirname, "..", "..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
const appFiles = files(join(ROOT, "app"));
const guide = guideText().toLowerCase();

describe("the Concierge guide", () => {
  it("covers every page", () => {
    const pages = appFiles
      .filter((f) => f.endsWith(`${sep}page.tsx`))
      .map((f) => "/" + relative(join(ROOT, "app"), f).split(sep).slice(0, -1).join("/"))
      .map((p) => p.replace(/\/\([^)]+\)/g, "") || "/");
    const covered = new Set(allTopics().flatMap((t) => t.routes ?? []));
    const missing = pages.filter((p) => !covered.has(p));
    expect(missing, `Add these pages to a topic's routes in lib/help/guide.ts and say what they're for`).toEqual([]);
  });

  it("names every settings section", () => {
    const titles = new Set<string>();
    for (const f of appFiles.filter((f) => f.endsWith(".tsx"))) {
      for (const m of readFileSync(f, "utf8").matchAll(/<Section title="([^"]+)"/g)) titles.add(m[1]);
    }
    expect(titles.size).toBeGreaterThan(10);
    // "System (only you see this)" is named as "System".
    const missing = [...titles].filter((t) => !guide.includes(t.replace(/\s*\(.*?\)\s*/g, "").toLowerCase()));
    expect(missing, `Say what these sections are and where they are in lib/help/guide.ts`).toEqual([]);
  });

  it("names every link in the side menu and the top bar", () => {
    const labels = new Set<string>();
    for (const f of ["components/chat/Sidebar.tsx", "components/AppHeader.tsx"]) {
      for (const m of readFileSync(join(ROOT, f), "utf8").matchAll(/<NavLink[^>]*>([^<{]+)<\/NavLink>/g)) labels.add(m[1].trim());
    }
    expect(labels.size).toBeGreaterThan(3);
    expect([...labels].filter((l) => !guide.includes(l.toLowerCase()))).toEqual([]);
  });

  it("names every item in a chat's three-dots menu", () => {
    const src = readFileSync(join(ROOT, "components/chat/ChatMenu.tsx"), "utf8");
    const items = [...src.matchAll(/role="menuitem"[\s\S]*?>\s*([^<]*?)\s*<\/button>/g)]
      .flatMap((m) => [...m[1].matchAll(/"([A-Z][a-z]+)"|^([A-Z][a-z]+)$/g)].map((x) => x[1] ?? x[2]));
    expect(items.length).toBeGreaterThan(3);
    expect(items.filter((i) => !guide.includes(i.toLowerCase()))).toEqual([]);
  });

  it("lists every provider and model from the live model list", () => {
    for (const p of PROVIDERS) expect(guideText()).toContain(p.name);
    for (const m of MODELS) expect(guideText()).toContain(m.name);
  });

  it("links only to pages that exist", () => {
    const pages = new Set(
      appFiles.filter((f) => f.endsWith(`${sep}page.tsx`)).map((f) => "/" + relative(join(ROOT, "app"), f).split(sep).slice(0, -1).join("/")),
    );
    const links = [...guideText().matchAll(/\]\((\/[^)#\s]*)/g)].map((m) => m[1].replace(/\/$/, "") || "/");
    expect(links.length).toBeGreaterThan(5);
    expect(links.filter((l) => !pages.has(l === "/" ? "/" : l))).toEqual([]);
  });
});

describe("Concierge", () => {
  const ctx = (over: Partial<HelpContext> = {}): HelpContext => ({
    name: "Bea", role: "member", isOwner: false, providers: [], models: [], spent: 1.5, cap: 10, ...over,
  });

  it("asks Claude Haiku first, then cheap models the family has, never Groq", () => {
    expect(CONCIERGE_MODELS[0]).toBe("claude-haiku-5-5");
    for (const id of CONCIERGE_MODELS) expect(MODELS.some((m) => m.id === id)).toBe(true);
    expect(conciergeModels([{ provider: "anthropic" }, { provider: "openai" }]).map((m) => m.id)).toEqual(["claude-haiku-5-5", "gpt-6-luna"]);
    expect(conciergeModels([{ provider: "google" }]).map((m) => m.id)).toEqual(["gemini-3.5-flash-lite"]);
    expect(conciergeModels([{ provider: "groq" }])).toEqual([]);
    // A key that can't use Haiku skips it.
    expect(conciergeModels([{ provider: "anthropic", models: ["claude-sonnet-5-5"] }, { provider: "xai" }]).map((m) => m.id)).toEqual(["grok-4.3"]);
  });

  it("knows the person's role and their family's keys, never anything from their chats", () => {
    const member = personalLines(ctx({ providers: ["google"], models: ["Gemini 3.8 Flash"] }));
    expect(member).toMatch(/member/);
    expect(member).toMatch(/ask their family admin/);
    expect(member).toContain("keys for: Google");
    expect(member).toMatch(/No key yet for: .*xAI/);
    const admin = personalLines(ctx({ role: "admin", providers: ["anthropic", "xai"] }));
    expect(admin).toMatch(/family admin/);
    expect(personalLines(ctx({ role: "admin", isOwner: true }))).toMatch(/owner/);
    const system = conciergeSystem(ctx());
    expect(system).toContain("# Depeche guide");
    expect(system).toContain("Prompt caching");
  });
});
