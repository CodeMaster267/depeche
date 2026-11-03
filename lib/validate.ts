/** Input rules shared by the forms and the server actions. */

export const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;
export const MIN_PASSWORD = 10;

export function cleanEmail(v: unknown): string | null {
  const s = String(v ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254 ? s : null;
}

export function cleanName(v: unknown, max = 60): string | null {
  const s = String(v ?? "").trim().replace(/\s+/g, " ");
  return s.length >= 1 && s.length <= max ? s : null;
}

export function cleanUsername(v: unknown): string | null {
  const s = String(v ?? "").trim().toLowerCase();
  return USERNAME_RE.test(s) ? s : null;
}

export function passwordProblem(v: unknown): string | null {
  const s = String(v ?? "");
  if (s.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (s.length > 72) return "Use 72 characters or fewer.";
  return null;
}

/** Only allow redirects back into Depeche. */
export function safeNext(v: unknown): string {
  const s = String(v ?? "");
  return s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\") ? s : "/";
}
