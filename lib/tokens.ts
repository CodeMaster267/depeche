import { createHash, randomBytes } from "node:crypto";

/** A new invite token for the link, and the hash that is stored instead of it. */
export function newInviteToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
