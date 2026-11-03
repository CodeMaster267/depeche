/** Shared by the server (before speaking) and the browser (for its built-in voice). */

/** Text a person would hear: Markdown symbols, code and links read badly aloud. */
export function speakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, " (code shown on screen) ")
    .replace(/\$\$[\s\S]*?\$\$/g, " (formula shown on screen) ")
    .replace(/\$([^$\n]+)\$/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\^\d+\]:.*$/gm, "")
    .replace(/\[\^\d+\]/g, "")
    .replace(/\[\d+\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, "")
    .replace(/\|/g, ", ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~|`)/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * Splits a reply that is still being written into the part ready to speak and the rest. The first
 * piece is spoken as soon as it has a sentence or two, so voice chat starts talking quickly.
 */
export function readyToSpeak(text: string, done: boolean, first: boolean): { ready: string; rest: string } {
  if (done) return { ready: text, rest: "" };
  const min = first ? 40 : 400;
  if (text.length < min) return { ready: "", rest: text };
  // The last sentence end after the minimum length, outside any unfinished code block.
  const fences = text.split("```").length - 1;
  if (fences % 2 === 1) return { ready: "", rest: text };
  const re = /[.!?\n](\s|$)/g;
  let cut = -1;
  for (let m = re.exec(text); m; m = re.exec(text)) if (m.index + 1 >= min) { cut = m.index + 1; if (first) break; }
  if (cut < 0) return { ready: "", rest: text };
  return { ready: text.slice(0, cut), rest: text.slice(cut) };
}
