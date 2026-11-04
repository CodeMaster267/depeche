/** Turns the file a person picked (an export zip, or the chats JSON from inside one) into chats. */
import { listZip, readZipEntry } from "./zip";
import { parseExport } from "./parse";
import type { ImportSource, ImportedChat } from "./types";

export type ReadResult = { ok: true; source: ImportSource; chats: ImportedChat[] } | { ok: false; error: string };

type PickedFile = Pick<Blob, "size" | "slice" | "text"> & { name: string };

export const NO_CHATS =
  "Couldn't find any chats in that file. Pick the zip you downloaded from ChatGPT, Claude or Google Takeout.";
export const GEMINI_HTML =
  "Google Takeout saved your Gemini activity as a web page. Export it again with “Multiple formats” set to JSON for My Activity, then pick that zip.";

const CHATS_FILE = /(^|\/)conversations(-\d+)?\.json$/i;
const GEMINI_JSON = /(^|\/)(Gemini Apps|Gemini|Bard)\/[^/]*\.json$/i;
const GEMINI_HTML_FILE = /(^|\/)(Gemini Apps|Gemini|Bard)\/[^/]*\.html?$/i;

function fromJson(texts: string[]): ReadResult {
  let source: ImportSource | null = null;
  const chats: ImportedChat[] = [];
  for (const text of texts) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      continue;
    }
    const got = parseExport(data);
    if (!got) continue;
    source ??= got.source;
    if (got.source === source) chats.push(...got.chats);
  }
  if (!source) return { ok: false, error: NO_CHATS };
  return { ok: true, source, chats };
}

export async function readExport(file: PickedFile): Promise<ReadResult> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  if (!isZip) {
    if (!/\.json$/i.test(file.name)) return { ok: false, error: NO_CHATS };
    return fromJson([await file.text()]);
  }
  let entries;
  try {
    entries = await listZip(file);
  } catch {
    return { ok: false, error: "That zip couldn't be opened. Download the export again and pick the new zip." };
  }
  const wanted = entries.filter((e) => CHATS_FILE.test(e.name) || GEMINI_JSON.test(e.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (!wanted.length) {
    return { ok: false, error: entries.some((e) => GEMINI_HTML_FILE.test(e.name)) ? GEMINI_HTML : NO_CHATS };
  }
  const decoder = new TextDecoder();
  const texts: string[] = [];
  for (const e of wanted) texts.push(decoder.decode(await readZipEntry(file, e)));
  return fromJson(texts);
}
