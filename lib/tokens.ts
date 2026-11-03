import { createHash, randomBytes } from "node:crypto";

/** A new invite token for the link, and the hash that is stored instead of it. */
export function newInviteToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString("base64url");
  return { token, hash: hashToken(token) };
}

/**
 * A temporary password an admin reads out or writes down: 15 letters and digits in groups of five,
 * without look-alikes (0/o, 1/l/i). About 75 bits, and it only works for a day.
 */
export function newTempPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(15);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return [0, 5, 10].map((i) => chars.slice(i, i + 5).join("")).join("-");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
