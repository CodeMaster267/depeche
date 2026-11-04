/**
 * Canvas: a document or piece of code beside the chat that the person and the AI both edit.
 *
 * The AI writes a canvas as a fenced block labelled with its title, like ```canvas:Wedding-speech
 * or ```canvas:budget.py, and rewrites it whole (same title) to change it. The server saves each
 * finished block as a new version; the browser shows the block being written live in the pane.
 *
 * Shared by the server and the browser, so it has no dependencies.
 */

export const MAX_CANVAS_CHARS = 200_000;
/** How much of the open canvas is put in front of the model. */
export const CANVAS_PROMPT_CHARS = 100_000;

export type CanvasVersion = {
  id: string;
  content: string;
  author: "person" | "assistant";
  message_id: string | null;
  created_at: string;
};

export type Canvas = { id: string; title: string; updated_at: string; versions: CanvasVersion[] };

export type CanvasBlock = { title: string; content: string; closed: boolean };

/** Endings that make a canvas code (shown in a monospace editor) rather than a document. */
const CODE: Record<string, string> = {
  py: "Python", js: "JavaScript", mjs: "JavaScript", ts: "TypeScript", tsx: "TypeScript", jsx: "JavaScript",
  java: "Java", c: "C", h: "C", cpp: "C++", cc: "C++", hpp: "C++", cs: "C#", go: "Go", rs: "Rust", rb: "Ruby",
  php: "PHP", swift: "Swift", kt: "Kotlin", scala: "Scala", dart: "Dart", lua: "Lua", r: "R", jl: "Julia",
  sql: "SQL", sh: "Shell", bash: "Shell", zsh: "Shell", ps1: "PowerShell", html: "HTML", htm: "HTML", css: "CSS",
  scss: "SCSS", json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML", xml: "XML", svg: "SVG", vue: "Vue",
  svelte: "Svelte", txt: "Text", csv: "CSV", ini: "INI", tex: "LaTeX", m: "MATLAB", pl: "Perl", hs: "Haskell",
  ex: "Elixir", erl: "Erlang", clj: "Clojure", fs: "F#", vb: "Visual Basic", asm: "Assembly", gd: "GDScript",
};

const ending = (title: string) => /\.([a-z0-9]+)$/i.exec(title)?.[1]?.toLowerCase();

/** "Python" for budget.py; null for a document. */
export function codeLanguage(title: string): string | null {
  const ext = ending(title);
  return ext && ext in CODE ? CODE[ext] : null;
}

/** The highlight.js class for a code canvas, if the ending names a common language. */
export function highlightClass(title: string): string | undefined {
  const ext = ending(title);
  if (!ext || !(ext in CODE)) return undefined;
  const alias: Record<string, string> = { htm: "html", svg: "xml", yml: "yaml", mjs: "js", cc: "cpp", hpp: "cpp", h: "c", zsh: "bash", sh: "bash" };
  return `language-${alias[ext] ?? ext}`;
}

/** A canvas title as written in a block: no slashes or control characters, at most 120 letters. */
export function cleanTitle(raw: string): string {
  return raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/^[.\s-]+/, "")
    .slice(0, 120)
    .trim();
}

/** A document's title for people: "Wedding-speech" reads "Wedding speech". Code keeps its file name. */
export function displayTitle(title: string): string {
  if (codeLanguage(title)) return title;
  return title.replace(/\.(md|markdown)$/i, "").replace(/[-_]+/g, " ").trim() || title;
}

/** The canvas named by a code block's language, like "canvas:Trip-plan", or null. */
export function canvasFromLang(lang: string | undefined): string | null {
  const m = /^canvas:(.+)$/i.exec(lang ?? "");
  const title = m ? cleanTitle(m[1]) : "";
  return title || null;
}

const OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*canvas:([^\s`]+)[^\n`]*$/i;

/**
 * Every canvas block in a reply, in order. The last one may still be open while a reply streams;
 * only closed blocks are saved.
 */
export function canvasBlocks(text: string): CanvasBlock[] {
  const lines = text.split("\n");
  const out: CanvasBlock[] = [];
  // Fences that aren't canvases are skipped whole, so a canvas example inside code isn't one.
  let other: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (other) {
      if (closes(line, other)) other = null;
      continue;
    }
    const open = OPEN.exec(line);
    if (open) {
      const fence = open[1];
      const title = cleanTitle(open[2]);
      const body: string[] = [];
      let closed = false;
      for (i++; i < lines.length; i++) {
        if (closes(lines[i], fence)) {
          closed = true;
          break;
        }
        body.push(lines[i]);
      }
      if (title) out.push({ title, content: body.join("\n").slice(0, MAX_CANVAS_CHARS), closed });
      continue;
    }
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) other = fence[1];
  }
  return out;
}

function closes(line: string, fence: string): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!m && m[1][0] === fence[0] && m[1].length >= fence.length;
}

/**
 * What the model sees of its own earlier replies: each canvas block is swapped for a short note,
 * since the canvas's current text is given separately. Saves sending every old version again.
 */
export function withoutCanvasBlocks(text: string): string {
  if (!/canvas:/i.test(text)) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let other: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (other) {
      if (closes(line, other)) other = null;
      out.push(line);
      continue;
    }
    const open = OPEN.exec(line);
    if (open) {
      const fence = open[1];
      for (i++; i < lines.length && !closes(lines[i], fence); i++);
      out.push(`[Wrote the canvas "${cleanTitle(open[2])}" here.]`);
      continue;
    }
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) other = fence[1];
    out.push(line);
  }
  return out.join("\n");
}

/** The fence to wrap a canvas's text in for the model, longer than any fence inside it. */
export function fenceFor(content: string): string {
  const longest = Math.max(2, ...[...content.matchAll(/`{3,}/g)].map((m) => m[0].length));
  return "`".repeat(longest + 1);
}

/** A file name for saving a code canvas. Pages and pictures are saved as text, never to be opened as a page. */
export function codeFileName(title: string): string {
  return /\.(html?|xhtml|svg|xml)$/i.test(title) ? `${title}.txt` : title;
}

/** The newest version of a canvas. */
export const latest = (c: Canvas): CanvasVersion | undefined => c.versions[c.versions.length - 1];
