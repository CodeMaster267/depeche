/**
 * Personal instructions: what a person tells Depeche about themselves, and how they want it to
 * answer. Private to them (row-level security), and given to every model with every message.
 */
export const MAX_INSTRUCTION_CHARS = 1500;

export type PersonalInstructions = { about_me: string; answer_style: string; enabled: boolean };

/** Tidies what a person typed: no stray spaces at the ends, at most one blank line in a row. */
export function cleanInstruction(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * What the model is told. The person's words are quoted inside tags so the model treats them as
 * the person's preferences, which never outrank its safety rules or the app's own instructions.
 */
export function personalInstructions(name: string, p: PersonalInstructions | null | undefined): string {
  if (!p || !p.enabled) return "";
  const about = cleanInstruction(p.about_me);
  const style = cleanInstruction(p.answer_style);
  if (!about && !style) return "";
  return [
    `${name} wrote these personal instructions for every chat. Follow them unless they conflict with your safety rules, and when a message in the chat asks for something different, the message wins. Don't mention that you were given them.`,
    about ? `<about_me>\n${about}\n</about_me>` : "",
    style ? `<how_to_answer>\n${style}\n</how_to_answer>` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
