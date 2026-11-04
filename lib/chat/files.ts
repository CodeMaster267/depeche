/** Files attached to messages. Shared by the browser (checks before upload) and the server. */
export type FileRef = { path: string; name: string; mime: string; size: number };

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 5;
export const UPLOAD_BUCKET = "uploads";

export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
export const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
/** Word, Excel and PowerPoint files: the server reads their text and sends it to the model. */
export const OFFICE_TYPES = [DOCX, XLSX, PPTX];
export const ALLOWED_TYPES = [...IMAGE_TYPES, "application/pdf", "text/plain", ...OFFICE_TYPES];

/** Sent to the model as text (read on the server), rather than as a file the provider opens. */
export const readAsText = (mime: string) => mime === "text/plain" || OFFICE_TYPES.includes(mime);

/** Files with these endings are read as text, whatever type the browser guesses. */
const TEXT_ENDINGS =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|yaml|yml|toml|ini|log|html?|css|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|sql|r|m|tex|srt|vtt)$/i;

/** What a picked file will be stored as, or null if Depeche can't send it to a model. */
export function storedType(file: { name: string; type: string }): string | null {
  if (IMAGE_TYPES.includes(file.type)) return file.type;
  if (file.type.startsWith("image/")) return "image/jpeg"; // converted in the browser, e.g. iPhone HEIC photos
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return "application/pdf";
  if (file.type === DOCX || /\.docx$/i.test(file.name)) return DOCX;
  if (file.type === XLSX || /\.xlsx$/i.test(file.name)) return XLSX;
  if (file.type === PPTX || /\.pptx$/i.test(file.name)) return PPTX;
  if (file.type.startsWith("text/") || file.type === "application/json" || TEXT_ENDINGS.test(file.name)) return "text/plain";
  return null;
}

/** Why a picked file can't be sent, in a few words. */
export function refusal(file: { name: string }): string {
  if (/\.(doc|xls|ppt|rtf|odt|ods|odp)$/i.test(file.name)) return "Save it as .docx, .xlsx or .pptx";
  if (/\.(pages|numbers|key)$/i.test(file.name)) return "Export it to Word, Excel or PDF";
  return "Can't send this kind of file";
}

export function isFileRef(v: unknown, ownerId: string): v is FileRef {
  if (!v || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.path === "string" &&
    f.path.startsWith(`${ownerId}/`) &&
    f.path.length < 300 &&
    !f.path.includes("..") &&
    typeof f.name === "string" &&
    f.name.length > 0 &&
    f.name.length <= 200 &&
    typeof f.mime === "string" &&
    ALLOWED_TYPES.includes(f.mime) &&
    typeof f.size === "number" &&
    f.size > 0 &&
    f.size <= MAX_FILE_BYTES
  );
}

export function sizeLabel(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
