"use client";

/** Browser side of the app lock: settings from the `dp_lock` cookie, and Face ID / Touch ID calls. */

export type LockSettings = { timeout: number; pinLength: number; passkeys: boolean };

export function readLockSettings(): LockSettings | null {
  const m = /(?:^|;\s*)dp_lock=(\d+)\.(\d+)\.(\d)/.exec(document.cookie);
  if (!m) return null;
  return { timeout: Number(m[1]), pinLength: Number(m[2]), passkeys: m[3] === "1" };
}

const toBuf = (s: string) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out.buffer;
};
const toB64u = (buf: ArrayBuffer | null) => {
  if (!buf) return "";
  let s = "";
  for (const byte of new Uint8Array(buf)) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Whether this device can do Face ID, Touch ID or similar for websites. */
export async function canUseBiometrics(): Promise<boolean> {
  try {
    return typeof PublicKeyCredential !== "undefined" && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

/** What to call the device's biometrics, for buttons. */
export function biometricName(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "Face ID";
  if (/Macintosh/.test(ua)) return "Touch ID";
  if (/Windows/.test(ua)) return "Windows Hello";
  return "fingerprint or face";
}

/** A short name for this device, shown in the list of devices with Face ID set up. */
export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  return "This device";
}

type Creation = {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: "public-key"; alg: number }[];
  authenticatorSelection: AuthenticatorSelectionCriteria;
  excludeCredentials: { type: "public-key"; id: string }[];
  attestation: AttestationConveyancePreference;
  timeout: number;
};

/** Makes a passkey on this device. Returns what the server needs to save it. */
export async function createPasskey(o: Creation) {
  const cred = (await navigator.credentials.create({
    publicKey: {
      ...o,
      challenge: toBuf(o.challenge),
      user: { ...o.user, id: toBuf(o.user.id) },
      excludeCredentials: o.excludeCredentials.map((c) => ({ ...c, id: toBuf(c.id) })),
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("cancelled");
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: toB64u(cred.rawId),
    clientDataJSON: toB64u(r.clientDataJSON),
    authenticatorData: toB64u(r.getAuthenticatorData()),
    publicKey: toB64u(r.getPublicKey()),
    algorithm: r.getPublicKeyAlgorithm(),
  };
}

type Request = { challenge: string; rpId: string; allowCredentials: { type: "public-key"; id: string }[]; userVerification: UserVerificationRequirement; timeout: number };

/** Asks for Face ID / Touch ID and has the server check it. True if this device is now unlocked. */
export async function unlockWithPasskey(): Promise<boolean> {
  const o = (await (await fetch("/api/lock/options", { method: "POST" })).json()) as Request;
  if (!o.challenge) return false;
  const cred = (await navigator.credentials.get({
    publicKey: { ...o, challenge: toBuf(o.challenge), allowCredentials: o.allowCredentials.map((c) => ({ ...c, id: toBuf(c.id) })) },
  })) as PublicKeyCredential | null;
  if (!cred) return false;
  const r = cred.response as AuthenticatorAssertionResponse;
  const res = await fetch("/api/lock/passkey", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: toB64u(cred.rawId),
      clientDataJSON: toB64u(r.clientDataJSON),
      authenticatorData: toB64u(r.authenticatorData),
      signature: toB64u(r.signature),
    }),
  });
  return res.ok;
}

/** This device has a passkey for Depeche (so the lock screen can offer Face ID straight away). */
export const PASSKEY_HERE = "dp_passkey_here";
export function markPasskeyHere(on: boolean) {
  try {
    if (on) localStorage.setItem(PASSKEY_HERE, "1");
    else localStorage.removeItem(PASSKEY_HERE);
  } catch {}
}
export function passkeyHere(): boolean {
  try {
    return localStorage.getItem(PASSKEY_HERE) === "1";
  } catch {
    return false;
  }
}
