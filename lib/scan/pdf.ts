/**
 * Scanned pages into one PDF, in the browser. Each page is a JPEG; the PDF page is A4 wide (or A4
 * tall when the page lies sideways) with the scan's own shape, so nothing is stretched or cut.
 */
export type ScanPage = { jpeg: Uint8Array; width: number; height: number };

/** Most pages one scan can hold. */
export const MAX_SCAN_PAGES = 30;

const A4_SHORT = 595.28;
const A4_LONG = 841.89;

export async function scansToPdf(pages: ScanPage[], title: string): Promise<Blob> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setCreator("Depeche");
  doc.setProducer("Depeche");
  for (const p of pages) {
    const image = await doc.embedJpg(p.jpeg);
    const landscape = p.width > p.height;
    const w = landscape ? A4_LONG : A4_SHORT;
    const h = (w * p.height) / p.width;
    const page = doc.addPage([w, h]);
    page.drawImage(image, { x: 0, y: 0, width: w, height: h });
  }
  const bytes = await doc.save();
  return new Blob([bytes as BlobPart], { type: "application/pdf" });
}

/** "Scan 4 Nov 2026 14.05", for a scan the person didn't name. */
export function scanName(now = new Date()): string {
  const day = now.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const time = `${String(now.getHours()).padStart(2, "0")}.${String(now.getMinutes()).padStart(2, "0")}`;
  return `Scan ${day} ${time}`;
}

/** A name that's safe as a file name, ending in .pdf. */
export function pdfFileName(name: string): string {
  const base = name
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .trim()
    .slice(0, 120);
  return `${base || scanName()}.pdf`;
}
