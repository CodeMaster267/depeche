/** Files attached to messages. Shared by the browser (checks before upload) and the server. */
export type FileRef = { path: string; name: string; mime: string; size: number };

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 5;
export const UPLOAD_BUCKET = "uploads";

export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
export const ALLOWED_TYPES = [...IMAGE_TYPES, "application/pdf", "text/plain"];

/** Files with these endings are read as text, whatever type the browser guesses. */
const TEXT_ENDINGS =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|yaml|yml|toml|ini|log|html?|css|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|sql|r|m|tex|srt|vtt)$/i;

/** What a picked file will be stored as, or null if Depeche can't send it to a model. */
export function storedType(file: { name: string; type: string }): string | null {
  if (IMAGE_TYPES.includes(file.type)) return file.type;
  if (file.type.startsWith("image/")) return "image/jpeg"; // converted in the browser, e.g. iPhone HEIC photos
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return "application/pdf";
  if (file.type.startsWith("text/") || file.type === "application/json" || TEXT_ENDINGS.test(file.name)) return "text/plain";
  return null;
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
