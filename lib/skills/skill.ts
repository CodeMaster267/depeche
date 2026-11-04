/**
 * Skills: packs of instructions, and optionally a few text files, that a chat picks up by itself
 * when a message is about what the skill covers (like Claude's skills). A model writes each one
 * and chooses its name; every skill is in one library everyone on Depeche can see, and each person
 * picks which ones are theirs. Shared by the server and the browser.
 */

export const MAX_DESCRIPTION = 300;
export const MAX_INSTRUCTIONS = 12_000;
export const MAX_FILES = 4;
export const MAX_FILE_CHARS = 9_000;
export const MAX_TRIGGERS = 30;
/** What a person may type when describing a new skill or a change to one. */
export const MAX_BRIEF = 2_000;
/** Skills one person can have in "My skills" (also enforced by the database). */
export const MAX_PICKS = 50;

export type SkillFile = { name: string; content: string };

export type SkillDraft = {
  name: string;
  description: string;
  instructions: string;
  files: SkillFile[];
  triggers: string[];
};

export type Skill = SkillDraft & {
  id: string;
  owner_id: string;
  family_id: string;
  model: string | null;
  version: number;
  status: "published" | "removed";
  removed_note?: string | null;
  created_at: string;
  updated_at: string;
};

/** Tidies text: no stray spaces at line ends, at most one blank line in a row, no control characters. */
export function tidy(text: unknown, max: number): string {
  if (typeof text !== "string") return "";
  return text
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

/**
 * A skill name as the database takes it: lowercase words joined by hyphens, 3 to 40 characters.
 * "Family Budget!" becomes "family-budget". Returns "" when nothing usable is left.
 */
export function skillName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const name = raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return name.length >= 3 ? name : "";
}

/** "family-budget" → "Family budget", for headings. */
export function displayName(name: string): string {
  const words = name.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A file name the skill can carry: short, no folders, a plain text ending. */
export function fileName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[^A-Za-z0-9._ -]/g, "").replace(/\s+/g, "-").replace(/^[.-]+/, "").slice(0, 60);
  if (!clean) return "";
  return /\.(md|txt|csv|json)$/i.test(clean) ? clean : `${clean.replace(/\.[^.]*$/, "")}.md`;
}

/** Trigger words, lowercased, without duplicates. */
export function cleanTriggers(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\n]/) : [];
  const out: string[] = [];
  for (const t of list) {
    if (typeof t !== "string") continue;
    const w = t.toLowerCase().replace(/[^\p{L}\p{N}' -]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 40);
    if (w.length >= 3 && !out.includes(w)) out.push(w);
    if (out.length >= MAX_TRIGGERS) break;
  }
  return out;
}

/** Whatever a model (or an edit form) sent, made into a draft the database accepts, or undefined. */
export function cleanDraft(raw: Record<string, unknown>, fallbackName = ""): SkillDraft | undefined {
  const name = skillName(raw.name) || skillName(fallbackName);
  const description = tidy(raw.description, MAX_DESCRIPTION).replace(/\s*\n\s*/g, " ");
  const instructions = tidy(raw.instructions, MAX_INSTRUCTIONS);
  if (!name || !description || !instructions) return undefined;
  const files: SkillFile[] = [];
  for (const f of Array.isArray(raw.files) ? raw.files : []) {
    if (!f || typeof f !== "object") continue;
    const n = fileName((f as SkillFile).name);
    const content = tidy((f as SkillFile).content, MAX_FILE_CHARS);
    if (!n || !content || files.some((x) => x.name.toLowerCase() === n.toLowerCase())) continue;
    files.push({ name: n, content });
    if (files.length >= MAX_FILES) break;
  }
  return { name, description, instructions, files, triggers: cleanTriggers(raw.triggers) };
}

/** Every bit of text in a skill, for screening. */
export function textsOf(d: SkillDraft): string[] {
  return [d.name.replace(/-/g, " "), d.description, d.instructions, ...d.files.flatMap((f) => [f.name, f.content]), d.triggers.join(", ")];
}
