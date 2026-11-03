import "server-only";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { serviceRoleKey } from "@/lib/config";

/**
 * AES-256-GCM for provider keys. The encryption key never touches the database:
 *
 *   - If DEPECHE_ENCRYPTION_KEY is set in Vercel, its SHA-256 is the key (format byte 2).
 *   - Otherwise the key is derived (HKDF-SHA256) from the Supabase secret key, which already lives
 *     only in Vercel (format byte 1). This keeps setup to zero extra steps.
 *
 * Stored layout: [format 1 byte][iv 12 bytes][auth tag 16 bytes][ciphertext]. Because the format
 * byte records which key was used, adding DEPECHE_ENCRYPTION_KEY later doesn't break older keys.
 */
const IV = 12;
const TAG = 16;

function keyFor(format: number): Buffer {
  if (format === 2) {
    const secret = process.env.DEPECHE_ENCRYPTION_KEY?.trim();
    if (!secret) throw new Error("DEPECHE_ENCRYPTION_KEY is not set");
    return createHash("sha256").update(secret).digest();
  }
  if (format === 1) {
    const base = serviceRoleKey();
    if (!base) throw new Error("Supabase secret key is not set");
    return Buffer.from(hkdfSync("sha256", base, "depeche", "provider-keys v1", 32));
  }
  throw new Error("Unknown key format");
}

export function encryptSecret(plain: string): Buffer {
  const format = process.env.DEPECHE_ENCRYPTION_KEY?.trim() ? 2 : 1;
  const iv = randomBytes(IV);
  const cipher = createCipheriv("aes-256-gcm", keyFor(format), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([format]), iv, cipher.getAuthTag(), body]);
}

export function decryptSecret(sealed: Buffer): string {
  const format = sealed[0];
  const iv = sealed.subarray(1, 1 + IV);
  const tag = sealed.subarray(1 + IV, 1 + IV + TAG);
  const decipher = createDecipheriv("aes-256-gcm", keyFor(format), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(1 + IV + TAG)), decipher.final()]).toString("utf8");
}

/** Postgres bytea travels through Supabase as a "\x…" hex string. */
export const toBytea = (b: Buffer) => `\\x${b.toString("hex")}`;
export const fromBytea = (s: string) => Buffer.from(s.replace(/^\\x/, ""), "hex");
