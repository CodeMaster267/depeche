import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { serviceRoleKey } from "@/lib/config";

/**
 * App lock state that travels in cookies. Shared by the proxy (which runs before every request)
 * and the lock routes, so it imports nothing server-only.
 *
 *  - `dp_unlock` (httpOnly, signed): this device is unlocked for person `u` in sign-in session `s`
 *    until `e`. Locking sets `e` to 0 rather than deleting it, so the server can tell "locked"
 *    from "just signed in".
 *  - `dp_lock` (readable by the page): the person's lock settings, so the page can lock itself
 *    after time without use. Only a hint for the page; the server never trusts it.
 */
export const UNLOCK_COOKIE = "dp_unlock";
export const SETTINGS_COOKIE = "dp_lock";
export const CHALLENGE_COOKIE = "dp_lock_ch";

/** Signing in again counts as unlocking, for this long after the sign-in. */
export const FRESH_SIGN_IN_SECONDS = 10 * 60;

/** With "lock as soon as you leave", the page keeps the server's unlock alive this long between check-ins. */
export const IMMEDIATE_WINDOW_SECONDS = 120;

/** What the server keeps in each person's sign-in record (Supabase app_metadata.lock). */
export type LockMeta = { t: number; n: number; pk: number };

export function lockMeta(appMetadata: Record<string, unknown> | undefined): LockMeta | null {
  const raw = appMetadata?.lock as Partial<LockMeta> | null | undefined;
  if (!raw || typeof raw.t !== "number" || typeof raw.n !== "number") return null;
  return { t: raw.t, n: raw.n, pk: Number(raw.pk) || 0 };
}

/** How long one unlock lasts on the server before the page has to check in again. */
export const windowFor = (meta: LockMeta) => (meta.t > 0 ? meta.t : IMMEDIATE_WINDOW_SECONDS);

/** `dp_lock` value: timeout seconds, PIN length, whether any passkeys exist. */
export const settingsCookieValue = (meta: LockMeta) => `${meta.t}.${meta.n}.${meta.pk > 0 ? 1 : 0}`;

let cachedKey: Buffer | null = null;
function key(): Buffer {
  if (cachedKey) return cachedKey;
  const base = process.env.DEPECHE_ENCRYPTION_KEY?.trim() || serviceRoleKey();
  if (!base) throw new Error("No secret for the app lock");
  cachedKey = Buffer.from(hkdfSync("sha256", base, "depeche", "app-lock v1", 32));
  return cachedKey;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (body: string) => createHmac("sha256", key()).update(body).digest();

/** A signed, tamper-proof cookie value holding `data`. */
export function sign(data: object): string {
  const body = b64(JSON.stringify(data));
  return `${body}.${b64(mac(body))}`;
}

/** The data in a value made by `sign`, or null if it was altered or isn't one. */
export function unsign<T>(value: string | undefined): T | null {
  if (!value) return null;
  const [body, sig] = value.split(".");
  if (!body || !sig) return null;
  const want = mac(body);
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

export type Unlock = { u: string; s: string; e: number };

export const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Decodes (without checking) a Supabase access token. Only call it on a token Supabase just accepted. */
export function sessionClaims(accessToken: string | undefined): { sessionId: string; authAt: number } | null {
  const part = accessToken?.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as {
      session_id?: string;
      amr?: { method: string; timestamp: number }[];
      iat?: number;
    };
    if (!claims.session_id) return null;
    const times = (claims.amr ?? []).map((a) => Number(a.timestamp)).filter(Number.isFinite);
    return { sessionId: claims.session_id, authAt: times.length ? Math.max(...times) : 0 };
  } catch {
    return null;
  }
}

/**
 * Whether this request may see the app. Unlocked if the cookie is for this person and sign-in
 * session and hasn't run out, or if this session signed in a moment ago and was never locked.
 */
export function unlockState(
  cookie: string | undefined,
  userId: string,
  session: { sessionId: string; authAt: number } | null,
): { unlocked: boolean; fresh: boolean } {
  const now = nowSeconds();
  const u = unsign<Unlock>(cookie);
  const mine = u && u.u === userId && session && u.s === session.sessionId;
  if (mine) return { unlocked: u.e > now, fresh: false };
  const fresh = Boolean(session && now - session.authAt < FRESH_SIGN_IN_SECONDS);
  return { unlocked: fresh, fresh };
}

export const COOKIE_BASE = { path: "/", sameSite: "lax" as const, secure: Boolean(process.env.VERCEL) };
/** Unlock cookies outlive their `e`, so a locked device stays locked rather than looking signed-in fresh. */
export const UNLOCK_COOKIE_MAX_AGE = 60 * 60 * 24 * 400;
