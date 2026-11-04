import { unzipSync } from "fflate";
import { DOCX, PPTX, XLSX } from "@/lib/chat/files";

/**
 * Reads the text out of Word, Excel and PowerPoint files (.docx, .xlsx, .pptx), so any model can
 * read them: none of the providers takes these files directly. Each is a zip of XML; this reads
 * just the parts with the words in, as Markdown (headings, lists and tables kept), each sheet of
 * a spreadsheet as CSV, and each slide with its notes.
 *
 * The files come from people, so nothing in them is trusted: unpacking stops at a size limit (a
 * small zip can expand to gigabytes) and only plain text comes out.
 */

/** The most text taken from one file, the same as for a plain text file. */
export const MAX_TEXT = 200_000;
/** The most a file may unpack to. */
const MAX_UNZIPPED = 60 * 1024 * 1024;

export async function documentText(mime: string, bytes: Uint8Array): Promise<string> {
  const text = mime === DOCX ? docx(bytes) : mime === XLSX ? xlsx(bytes) : mime === PPTX ? pptx(bytes) : "";
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n[The rest of this file was too long to include.]` : text;
}

function unzip(bytes: Uint8Array, want: (name: string) => boolean): Record<string, string> {
  let total = 0;
  const files = unzipSync(bytes, {
    filter: (f) => {
      if (!want(f.name)) return false;
      total += f.originalSize;
      if (total > MAX_UNZIPPED) throw new Error("This file unpacks to more than Depeche will read.");
      return true;
    },
  });
  const decoder = new TextDecoder();
  return Object.fromEntries(Object.entries(files).map(([name, data]) => [name, decoder.decode(data)]));
}

/** Tags and the text between them, in order. */
function* tokens(xml: string): Generator<{ tag: string; close: boolean; selfClose: boolean; attrs: string } | { text: string }> {
  const re = /<(\/?)([\w:.-]+)([^>]*?)(\/?)>|<[!?][^>]*>|([^<]+)/g;
  for (let m; (m = re.exec(xml)); ) {
    if (m[5] !== undefined) yield { text: m[5] };
    else if (m[2]) yield { tag: m[2], close: m[1] === "/", selfClose: m[4] === "/", attrs: m[3] };
  }
}

const attr = (attrs: string, name: string) => decode(new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? "");

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) => {
    const lower = e.toLowerCase();
    if (lower[0] === "#") {
      const code = lower[1] === "x" ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[lower] ?? "";
  });
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
function markdownTable(rows: string[][]): string {
  const width = Math.max(...rows.map((r) => r.length));
  if (!rows.length || !width) return "";
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => cell(r[i] ?? "")).join(" | ")} |`;
  return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
}

/** A Word document as Markdown. */
function docx(bytes: Uint8Array): string {
  const parts = unzip(bytes, (n) => n === "word/document.xml" || n === "word/footnotes.xml");
  const xml = parts["word/document.xml"];
  if (!xml) throw new Error("This isn't a Word document.");
  const out: string[] = [];
  // Tables can sit inside tables; each level collects rows of cells of paragraphs.
  const tables: { rows: string[][]; cellText: string[] | null }[] = [];
  let para = "";
  let prefix = "";
  let inText = false;
  for (const t of tokens(xml)) {
    if ("text" in t) {
      if (inText) para += decode(t.text);
      continue;
    }
    const top = tables.at(-1);
    switch (t.tag) {
      case "w:t":
        inText = !t.close && !t.selfClose;
        break;
      case "w:tab":
        if (!t.close) para += "\t";
        break;
      case "w:br":
      case "w:cr":
        if (!t.close) para += "\n";
        break;
      case "w:p":
        if (!t.close && !t.selfClose) {
          para = "";
          prefix = "";
        } else if (t.close) {
          const text = para.trim();
          if (top?.cellText) top.cellText.push(text);
          else if (text) out.push(prefix + text);
          para = "";
        }
        break;
      case "w:pStyle": {
        const style = attr(t.attrs, "w:val");
        const level = /^heading\s*(\d)$/i.exec(style)?.[1];
        if (level) prefix = `${"#".repeat(Math.min(6, Number(level)))} `;
        else if (/^title$/i.test(style)) prefix = "# ";
        else if (/^subtitle$/i.test(style)) prefix = "## ";
        else if (/^(quote|intensequote)$/i.test(style)) prefix = "> ";
        break;
      }
      case "w:ilvl":
        if (!prefix || /^ *- $/.test(prefix)) prefix = `${"  ".repeat(Number(attr(t.attrs, "w:val")) || 0)}- `;
        break;
      case "w:numPr":
        if (!prefix && (t.selfClose || !t.close)) prefix = "- ";
        break;
      case "w:tbl":
        if (!t.close) tables.push({ rows: [], cellText: null });
        else {
          const done = tables.pop();
          const md = done ? markdownTable(done.rows) : "";
          const parent = tables.at(-1);
          if (parent?.cellText) parent.cellText.push(md.replace(/\n/g, " "));
          else if (md) out.push(md);
        }
        break;
      case "w:tr":
        if (!t.close && top) top.rows.push([]);
        break;
      case "w:tc":
        if (top && !t.close) top.cellText = [];
        else if (top?.cellText) {
          top.rows.at(-1)?.push(top.cellText.filter(Boolean).join(" "));
          top.cellText = null;
        }
        break;
    }
  }
  const notes = parts["word/footnotes.xml"];
  if (notes) {
    const texts = [...notes.matchAll(/<w:footnote\b[^>]*>([\s\S]*?)<\/w:footnote>/g)]
      .map((m) => [...m[1].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((x) => decode(x[1])).join("").trim())
      .filter(Boolean);
    if (texts.length) out.push("Footnotes:", ...texts.map((x, i) => `${i + 1}. ${x}`));
  }
  // List items sit on consecutive lines; everything else is a paragraph apart.
  const item = (s?: string) => /^ *- /.test(s ?? "");
  return out.map((s, i) => (i === 0 ? "" : item(s) && item(out[i - 1]) ? "\n" : "\n\n") + s).join("");
}

/** Column letters to a 0-based index: A → 0, AA → 26. */
function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const csvField = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Excel's built-in date and time number formats. */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Excel counts days from 30 December 1899. */
function excelDate(serial: number, withTime: boolean): string {
  const d = new Date(Math.round((serial - 25569) * 86400) * 1000);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return withTime && serial % 1 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

/** A spreadsheet: each sheet as CSV under its name. */
function xlsx(bytes: Uint8Array): string {
  const parts = unzip(
    bytes,
    (n) => n === "xl/workbook.xml" || n === "xl/_rels/workbook.xml.rels" || n === "xl/sharedStrings.xml" || n === "xl/styles.xml" || /^xl\/worksheets\/[^/]+\.xml$/.test(n),
  );
  const book = parts["xl/workbook.xml"];
  if (!book) throw new Error("This isn't an Excel spreadsheet.");

  const strings = [...(parts["xl/sharedStrings.xml"] ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) =>
    // Phonetic guides (<rPh>) repeat the text; leave them out.
    [...m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => decode(t[1])).join(""),
  );

  // Which cell styles show numbers as dates.
  const styles = parts["xl/styles.xml"] ?? "";
  const customDates = new Set(
    [...styles.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)]
      .filter((m) => /[dmyh]/i.test(decode(m[2]).replace(/"[^"]*"|\[[^\]]*\]/g, "")))
      .map((m) => Number(m[1])),
  );
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
  const dateStyle = [...xfs.matchAll(/<xf\b([^>]*)/g)].map((m) => {
    const id = Number(attr(m[1], "numFmtId"));
    return DATE_FORMATS.has(id) || customDates.has(id);
  });

  const rels = new Map(
    [...(parts["xl/_rels/workbook.xml.rels"] ?? "").matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => [attr(m[1], "Id"), attr(m[1], "Target")]),
  );
  const sheets = [...book.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => {
    const target = rels.get(attr(m[1], "r:id")) ?? "";
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    return { name: attr(m[1], "name"), xml: parts[path] ?? "" };
  });

  const out: string[] = [];
  let length = 0;
  for (const sheet of sheets) {
    const rows: string[][] = [];
    for (const row of sheet.xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const cells: string[] = [];
      for (const c of (row[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const type = attr(c[1], "t");
        const body = c[2] ?? "";
        const v = decode(/<v>([^<]*)<\/v>/.exec(body)?.[1] ?? "");
        let value = "";
        if (type === "s") value = strings[Number(v)] ?? "";
        else if (type === "inlineStr") value = [...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => decode(t[1])).join("");
        else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
        else if ((type === "" || type === "n") && v && dateStyle[Number(attr(c[1], "s")) || 0]) value = excelDate(Number(v), true);
        else value = v;
        const ref = attr(c[1], "r");
        const at = ref ? columnIndex(ref) : cells.length;
        if (at > 16_384) continue;
        while (cells.length < at) cells.push("");
        cells[at] = value;
      }
      rows.push(cells);
    }
    // Trailing empty rows are left out.
    while (rows.length && !rows.at(-1)!.some(Boolean)) rows.pop();
    const csv = rows.map((r) => r.map(csvField).join(",")).join("\n");
    out.push(`## Sheet: ${sheet.name}\n\n${csv || "(empty)"}`);
    length += csv.length;
    if (length > MAX_TEXT) break;
  }
  return out.join("\n\n");
}

/** A presentation: each slide's text, then its speaker notes. */
function pptx(bytes: Uint8Array): string {
  const parts = unzip(bytes, (n) => /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/.test(n) || /^ppt\/slides\/_rels\/[^/]+\.rels$/.test(n));
  const slideNumber = (n: string) => Number(/(\d+)\.xml$/.exec(n)?.[1] ?? 0);
  const slides = Object.keys(parts)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  if (!slides.length) throw new Error("This isn't a PowerPoint presentation.");
  const paragraphs = (xml: string) =>
    [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)]
      .map((p) => [...p[1].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => decode(t[1])).join("").trim())
      .filter(Boolean);
  return slides
    .map((name, i) => {
      const rels = parts[name.replace("slides/", "slides/_rels/") + ".rels"] ?? "";
      const notesTarget = /Target="\.\.\/notesSlides\/([^"]+)"/.exec(rels)?.[1];
      // Notes repeat the slide number in a placeholder; leave out lines that are just a number.
      const notes = notesTarget ? paragraphs(parts[`ppt/notesSlides/${notesTarget}`] ?? "").filter((p) => !/^\d+$/.test(p)) : [];
      const body = paragraphs(parts[name]);
      return [`## Slide ${i + 1}`, body.join("\n"), notes.length ? `Notes: ${notes.join("\n")}` : ""].filter(Boolean).join("\n\n");
    })
    .join("\n\n");
}
