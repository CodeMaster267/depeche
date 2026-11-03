/**
 * Files a model makes in a chat. A model writes the file's contents in a fenced block labelled
 * with the file's name (```file:Budget.xlsx); the browser turns that into the real file when the
 * person taps Download. Nothing is stored or sent anywhere: the reply already holds the contents.
 *
 * This part is small, for showing the card; lib/docs/write.ts makes the files and loads on demand.
 */
export type DocKind = "docx" | "pdf" | "xlsx" | "csv" | "md" | "txt" | "json";

export const KINDS: Record<DocKind, { label: string; short: string; mime: string; family: "doc" | "table" | "plain" }> = {
  docx: { label: "Word document", short: "Word", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", family: "doc" },
  pdf: { label: "PDF", short: "PDF", mime: "application/pdf", family: "doc" },
  md: { label: "Markdown", short: "Markdown", mime: "text/markdown;charset=utf-8", family: "doc" },
  xlsx: { label: "Excel spreadsheet", short: "Excel", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", family: "table" },
  csv: { label: "CSV spreadsheet", short: "CSV", mime: "text/csv;charset=utf-8", family: "table" },
  txt: { label: "Text file", short: "Text", mime: "text/plain;charset=utf-8", family: "plain" },
  json: { label: "JSON file", short: "JSON", mime: "application/json", family: "plain" },
};

/** The other kinds the same contents can be saved as. */
export function alternatives(kind: DocKind): DocKind[] {
  const family = KINDS[kind].family;
  if (family === "plain") return [];
  return (Object.keys(KINDS) as DocKind[]).filter((k) => k !== kind && KINDS[k].family === family);
}

/** The file named by a code block's language, like "file:Budget.xlsx", or null. */
export function fileFromLang(lang: string | undefined): { name: string; kind: DocKind } | null {
  const m = /^file:(.+)$/i.exec(lang ?? "");
  if (!m) return null;
  const name = m[1]
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/^[.\s-]+/, "")
    .slice(-120);
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  const kind = ext === "markdown" ? "md" : ext === "text" ? "txt" : ext;
  return kind && kind in KINDS && name.length > ext!.length + 1 ? { name, kind: kind as DocKind } : null;
}

/** The same name with another kind's ending. */
export const withKind = (name: string, kind: DocKind) => `${name.replace(/\.[a-z0-9]+$/i, "")}.${kind}`;

export type Built = { blob: Blob; /** Some characters couldn't be kept (PDF fonts cover Western letters only). */ lossy: boolean };
