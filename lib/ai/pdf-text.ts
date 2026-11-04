import "server-only";

/**
 * The text of a PDF (base64), or "" if it has none (a scan) or can't be read. Used for providers
 * whose models can't read PDFs themselves (DeepSeek, xAI).
 */
export async function pdfText(base64: string): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(Buffer.from(base64, "base64")));
    const { text } = await extractText(pdf, { mergePages: true });
    return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, 200_000);
  } catch {
    return "";
  }
}

/** A PDF's text wrapped the way Depeche puts attached text files into a message. */
export async function pdfAsText(name: string, base64: string): Promise<string> {
  const safe = name.replace(/"/g, "'");
  const body = await pdfText(base64);
  return body ? `\n\n<file name="${safe}">\n${body}\n</file>` : `\n\n[Attached ${safe}: no text could be read from this PDF.]`;
}
