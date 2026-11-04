import "server-only";
import { createHash, createHmac, createPublicKey, randomBytes, scrypt, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { promisify } from "node:util";
import { cookies, headers } from "next/headers";
import { serviceRoleKey } from "@/lib/config";
import { siteOrigin } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";
import { fromBytea, toBytea } from "@/lib/crypto";
import {
  CHALLENGE_COOKIE,
  COOKIE_BASE,
  FRESH_SIGN_IN_SECONDS,
  SETTINGS_COOKIE,
  UNLOCK_COOKIE,
  UNLOCK_COOKIE_MAX_AGE,
  lockMeta,
  nowSeconds,
  sessionClaims,
  settingsCookieValue,
  sign,
  unlockState,
  unsign,
  windowFor,
  type LockMeta,
} from "./token";

/** Extra time the server allows beyond the page's own timer, so the page always locks first. */
const GRACE_SECONDS = 60;
/** After this many wrong PINs in a row, this device is signed out. */
export const MAX_TRIES = 10;
export const TIMEOUTS = [0, 60, 300, 900, 3600] as const;

// ---------------------------------------------------------------------------------------------
// The person asking

export type LockSession = {
  userId: string;
  email: string;
  sessionId: string;
  authAt: number;
  meta: LockMeta | null;
  /** Signed in on this device in the last few minutes. */
  fresh: boolean;
};

/** The signed-in person, their sign-in session and their lock settings, or null. */
export async function lockSession(): Promise<LockSession | null> {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;
  const { data: s } = await supabase.auth.getSession();
  const claims = sessionClaims(s.session?.access_token);
  if (!claims) return null;
  return {
    userId: data.user.id,
    email: data.user.email ?? "",
    sessionId: claims.sessionId,
    authAt: claims.authAt,
    meta: lockMeta(data.user.app_metadata),
    fresh: nowSeconds() - claims.authAt < FRESH_SIGN_IN_SECONDS,
  };
}

/** Whether this device is unlocked right now (always true without a lock). */
export async function isUnlocked(s: LockSession): Promise<boolean> {
  if (!s.meta) return true;
  const store = await cookies();
  return unlockState(store.get(UNLOCK_COOKIE)?.value, s.userId, { sessionId: s.sessionId, authAt: s.authAt }).unlocked;
}

/** Marks this device unlocked for the person's chosen time (plus a little grace). */
export async function grantUnlock(s: LockSession, meta: LockMeta | null = s.meta): Promise<void> {
  const store = await cookies();
  const e = meta ? nowSeconds() + windowFor(meta) + GRACE_SECONDS : 0;
  store.set(UNLOCK_COOKIE, sign({ u: s.userId, s: s.sessionId, e }), { ...COOKIE_BASE, httpOnly: true, maxAge: UNLOCK_COOKIE_MAX_AGE });
  if (meta) store.set(SETTINGS_COOKIE, settingsCookieValue(meta), { ...COOKIE_BASE, maxAge: UNLOCK_COOKIE_MAX_AGE });
  else store.delete(SETTINGS_COOKIE);
}

/** Locks this device now. */
export async function revokeUnlock(s: LockSession): Promise<void> {
  const store = await cookies();
  store.set(UNLOCK_COOKIE, sign({ u: s.userId, s: s.sessionId, e: 0 }), { ...COOKIE_BASE, httpOnly: true, maxAge: UNLOCK_COOKIE_MAX_AGE });
}

// ---------------------------------------------------------------------------------------------
// Settings (server only: the browser can't read or write the lock tables)

type LockRow = { pin_hash: string; pin_length: number; timeout_seconds: number; failed_tries: number; wait_until: string | null };

export async function readLock(userId: string): Promise<LockRow | null> {
  const { data } = await supabaseAdmin()
    .from("app_locks")
    .select("pin_hash, pin_length, timeout_seconds, failed_tries, wait_until")
    .eq("owner_id", userId)
    .maybeSingle<LockRow>();
  return data;
}

/**
 * Copies the lock settings into the person's sign-in record, which the proxy reads on every
 * request without another database call. Returns what it wrote.
 */
export async function syncLockMeta(userId: string): Promise<LockMeta | null> {
  const admin = supabaseAdmin();
  const lock = await readLock(userId);
  const { count } = await admin.from("lock_passkeys").select("id", { count: "exact", head: true }).eq("owner_id", userId);
  const meta: LockMeta | null = lock ? { t: lock.timeout_seconds, n: lock.pin_length, pk: count ?? 0 } : null;
  const { error } = await admin.auth.admin.updateUserById(userId, { app_metadata: { lock: meta } });
  if (error) throw new Error("Couldn't save the lock settings");
  return meta;
}

// ---------------------------------------------------------------------------------------------
// PIN

export const PIN_PATTERN = /^\d{4,8}$/;

const scryptAsync = promisify(scrypt) as (pw: Buffer, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/**
 * A PIN has few possible values, so besides a slow hash it's mixed with a server secret first
 * (kept in Vercel, not the database). Someone holding only a database backup can't try PINs.
 */
function pepper(pin: string): Buffer {
  const base = process.env.DEPECHE_ENCRYPTION_KEY?.trim() || serviceRoleKey();
  if (!base) throw new Error("No secret for the app lock");
  return createHmac("sha256", createHash("sha256").update(`depeche app-lock pin v1:${base}`).digest()).update(pin).digest();
}

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(pepper(pin), salt, 32, SCRYPT);
  return `s1$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function pinMatches(pin: string, stored: string): Promise<boolean> {
  const [v, salt, hash] = stored.split("$");
  if (v !== "s1" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64url");
  const got = await scryptAsync(pepper(pin), Buffer.from(salt, "base64url"), want.length, SCRYPT);
  return timingSafeEqual(got, want);
}

export type PinResult = { ok: true } | { ok: false; error: string; waitSeconds?: number; signedOut?: boolean };

/** Checks a PIN, counting wrong ones. Ten wrong in a row signs this device out. */
export async function tryPin(s: LockSession, pin: string): Promise<PinResult> {
  const lock = await readLock(s.userId);
  if (!lock) return { ok: true };
  const waiting = lock.wait_until ? Math.ceil((new Date(lock.wait_until).getTime() - Date.now()) / 1000) : 0;
  if (waiting > 0) return { ok: false, error: `Too many wrong tries. Wait ${waitText(waiting)}.`, waitSeconds: waiting };

  const ok = PIN_PATTERN.test(pin) && (await pinMatches(pin, lock.pin_hash));
  const { data } = await supabaseAdmin().rpc("lock_pin_attempt", { p_user: s.userId, p_ok: ok }).single<{ failed_tries: number; wait_until: string | null }>();
  if (ok) return { ok: true };

  const tries = data?.failed_tries ?? lock.failed_tries + 1;
  if (tries >= MAX_TRIES) {
    await supabaseAdmin().rpc("lock_pin_attempt", { p_user: s.userId, p_ok: true });
    await (await supabaseServer()).auth.signOut({ scope: "local" });
    return { ok: false, signedOut: true, error: "Too many wrong tries, so you've been signed out on this device." };
  }
  const wait = data?.wait_until ? Math.ceil((new Date(data.wait_until).getTime() - Date.now()) / 1000) : 0;
  if (wait > 0) return { ok: false, error: `Wrong PIN. Wait ${waitText(wait)} to try again.`, waitSeconds: wait };
  const left = 5 - tries;
  return { ok: false, error: left <= 2 ? `Wrong PIN. ${left} more ${left === 1 ? "try" : "tries"} before a wait.` : "Wrong PIN." };
}

function waitText(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const m = Math.ceil(seconds / 60);
  return `${m} minute${m === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------------------------
// Face ID / Touch ID (WebAuthn passkeys). Verified here without a library: the browser hands over
// the public key in a standard format (SPKI), and each unlock is a signature we check with it.

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const unb64u = (s: unknown) => Buffer.from(String(s ?? ""), "base64url");

async function relyingParty(): Promise<{ id: string; origin: string }> {
  const origin = await siteOrigin();
  return { id: new URL(origin).hostname, origin };
}

/** A one-time challenge for the browser to sign, remembered in a signed cookie for two minutes. */
async function newChallenge(userId: string, purpose: "create" | "get"): Promise<string> {
  const c = b64u(randomBytes(32));
  (await cookies()).set(CHALLENGE_COOKIE, sign({ c, u: userId, p: purpose, e: nowSeconds() + 120 }), {
    ...COOKIE_BASE,
    httpOnly: true,
    maxAge: 120,
  });
  return c;
}

async function takeChallenge(userId: string, purpose: "create" | "get"): Promise<string | null> {
  const store = await cookies();
  const ch = unsign<{ c: string; u: string; p: string; e: number }>(store.get(CHALLENGE_COOKIE)?.value);
  store.delete(CHALLENGE_COOKIE);
  if (!ch || ch.u !== userId || ch.p !== purpose || ch.e < nowSeconds()) return null;
  return ch.c;
}

export type PasskeyRow = { id: string; credential_id: string; public_key: string; algorithm: number; sign_count: number; label: string };

async function passkeysOf(userId: string): Promise<PasskeyRow[]> {
  const { data } = await supabaseAdmin()
    .from("lock_passkeys")
    .select("id, credential_id, public_key, algorithm, sign_count, label")
    .eq("owner_id", userId)
    .returns<PasskeyRow[]>();
  return data ?? [];
}

/** Options for `navigator.credentials.create`, with binary fields as base64url. */
export async function registrationOptions(s: LockSession, displayName: string) {
  const rp = await relyingParty();
  const existing = await passkeysOf(s.userId);
  return {
    challenge: await newChallenge(s.userId, "create"),
    rp: { id: rp.id, name: "Depeche" },
    user: { id: b64u(Buffer.from(s.userId.replaceAll("-", ""), "hex")), name: s.email || displayName, displayName },
    pubKeyCredParams: [
      { type: "public-key" as const, alg: -7 },
      { type: "public-key" as const, alg: -257 },
    ],
    authenticatorSelection: { authenticatorAttachment: "platform" as const, userVerification: "required" as const, residentKey: "preferred" as const },
    excludeCredentials: existing.map((p) => ({ type: "public-key" as const, id: p.credential_id })),
    attestation: "none" as const,
    timeout: 60_000,
  };
}

/** Options for `navigator.credentials.get`. */
export async function unlockOptions(s: LockSession) {
  const rp = await relyingParty();
  const keys = await passkeysOf(s.userId);
  return {
    challenge: await newChallenge(s.userId, "get"),
    rpId: rp.id,
    allowCredentials: keys.map((p) => ({ type: "public-key" as const, id: p.credential_id })),
    userVerification: "required" as const,
    timeout: 60_000,
  };
}

type ClientData = { type?: string; challenge?: string; origin?: string };

/** Checks what the browser says it signed, and the authenticator's data. Returns that data. */
function checkCommon(
  clientDataJSON: Buffer,
  authData: Buffer,
  want: { type: string; challenge: string; origin: string; rpId: string },
): string | null {
  let cd: ClientData;
  try {
    cd = JSON.parse(clientDataJSON.toString("utf8")) as ClientData;
  } catch {
    return "bad client data";
  }
  if (cd.type !== want.type) return "wrong type";
  if (cd.challenge !== want.challenge) return "wrong challenge";
  if (cd.origin !== want.origin) return "wrong origin";
  if (authData.length < 37) return "short authenticator data";
  if (!authData.subarray(0, 32).equals(createHash("sha256").update(want.rpId).digest())) return "wrong site";
  const flags = authData[32];
  if (!(flags & 0x01)) return "no user presence";
  if (!(flags & 0x04)) return "no Face ID or Touch ID";
  return null;
}

function keyFor(der: Buffer, alg: number): KeyObject | null {
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (alg === -7 && key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1") return key;
    if (alg === -257 && key.asymmetricKeyType === "rsa") return key;
    return null;
  } catch {
    return null;
  }
}

export type NewPasskey = { id: string; clientDataJSON: string; authenticatorData: string; publicKey: string; algorithm: number };

/** Verifies a new passkey from `navigator.credentials.create` and saves it. */
export async function savePasskey(s: LockSession, body: NewPasskey, label: string): Promise<string | null> {
  const rp = await relyingParty();
  const challenge = await takeChallenge(s.userId, "create");
  if (!challenge) return "That took too long. Try again.";
  const authData = unb64u(body.authenticatorData);
  const problem = checkCommon(unb64u(body.clientDataJSON), authData, { type: "webauthn.create", challenge, origin: rp.origin, rpId: rp.id });
  if (problem) return `Couldn't set that up (${problem}).`;
  // The new credential's id is inside the authenticator data; it must match what the browser sent.
  if (!(authData[32] & 0x40) || authData.length < 55) return "Couldn't set that up (no new key).";
  const idLen = authData.readUInt16BE(53);
  const credId = authData.subarray(55, 55 + idLen);
  if (b64u(credId) !== body.id) return "Couldn't set that up (key mismatch).";
  const der = unb64u(body.publicKey);
  if (!keyFor(der, Number(body.algorithm))) return "This device's key type isn't supported.";

  const { error } = await supabaseAdmin()
    .from("lock_passkeys")
    .insert({ owner_id: s.userId, credential_id: body.id, public_key: toBytea(der), algorithm: Number(body.algorithm), label, sign_count: authData.readUInt32BE(33) });
  if (error) return error.code === "23505" ? "This device is already set up." : "Couldn't save it. Try again.";
  return null;
}

export type Assertion = { id: string; clientDataJSON: string; authenticatorData: string; signature: string };

/** Verifies a Face ID / Touch ID unlock from `navigator.credentials.get`. */
export async function checkPasskey(s: LockSession, body: Assertion): Promise<boolean> {
  const rp = await relyingParty();
  const challenge = await takeChallenge(s.userId, "get");
  if (!challenge) return false;
  const key = (await passkeysOf(s.userId)).find((p) => p.credential_id === body.id);
  if (!key) return false;
  const clientDataJSON = unb64u(body.clientDataJSON);
  const authData = unb64u(body.authenticatorData);
  if (checkCommon(clientDataJSON, authData, { type: "webauthn.get", challenge, origin: rp.origin, rpId: rp.id })) return false;
  const pub = keyFor(fromBytea(key.public_key), key.algorithm);
  if (!pub) return false;
  const signed = Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]);
  if (!verify("sha256", signed, pub, unb64u(body.signature))) return false;
  // Authenticators that count uses must count up; a repeat means a copied key.
  const count = authData.readUInt32BE(33);
  if ((count > 0 || Number(key.sign_count) > 0) && count <= Number(key.sign_count)) return false;
  await supabaseAdmin().from("lock_passkeys").update({ sign_count: count, last_used_at: new Date().toISOString() }).eq("id", key.id);
  return true;
}

/** A short name for the device a passkey was made on, from its browser. */
export async function deviceLabel(): Promise<string> {
  const ua = (await headers()).get("user-agent") ?? "";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  return "This device";
}
