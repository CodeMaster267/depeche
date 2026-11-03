/**
 * Models write maths in several ways. remark-math understands $…$ and $$…$$, so \(…\) and \[…\]
 * are rewritten to those. Dollar amounts like "$5 and $10" are escaped so they stay money.
 * Code is left exactly as written.
 */
export function normaliseMaths(text: string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `\n$$\n${m.trim()}\n$$\n`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$${m.trim()}$`)
        .replace(/(^|[^\\$])\$(\d[\d,]*(?:\.\d+)?(?:[kKmMbB]n?)?)(?![\d$])(?=[\s.,;:!?)\]/-]|$)/g, "$1\\$$$2");
    })
    .join("");
}
