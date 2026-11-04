import "server-only";
import { createHmac, hkdfSync } from "node:crypto";
import { serviceRoleKey } from "@/lib/config";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";
import { sessionClaims } from "@/lib/lock/token";
import { DEMO_SECONDS, demoEntries, demoState } from "./demo-meta";

/** Demo keys are compared without case or extra spaces, so "Banana " works like "banana". */
export const normalDemoKey = (word: unknown) =>
  String(word ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 100);

let cachedKey: Buffer | null = null;
/**
 * A keyed hash, so the stored value can't be checked against a dictionary without the server's
 * secret (a plain hash of a word like "banana" would give it away in seconds).
 */
export function demoKeyHash(word: string): string {
  if (!cachedKey) {
    const base = process.env.DEPECHE_ENCRYPTION_KEY?.trim() || serviceRoleKey();
    if (!base) throw new Error("No secret for demo keys");
    cachedKey = Buffer.from(hkdfSync("sha256", base, "depeche", "demo-key v1", 32));
  }
  return createHmac("sha256", cachedKey).update(normalDemoKey(word)).digest("hex");
}

/** A keyed hash of the random id this browser keeps for demo keys, so the raw id isn't stored. */
export function demoDeviceHash(device: string): string {
  demoKeyHash("");
  return createHmac("sha256", cachedKey!).update(`device:${device}`).digest("hex");
}

/** Marks a new sign-in session of the owner's as a demo, and forgets demos that have ended. */
export async function markDemoSession(userId: string, sessionId: string): Promise<void> {
  const admin = supabaseAdmin();
  const { data } = await admin.auth.admin.getUserById(userId);
  const now = Math.floor(Date.now() / 1000);
  const keep = demoEntries(data.user?.app_metadata).filter((d) => d.e > now);
  const { error } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: { demo: [...keep, { s: sessionId, e: now + DEMO_SECONDS }].slice(-20) },
  });
  if (error) throw new Error("Couldn't start the demo");
}

/** True when this request comes from a demo session (active or ended). */
export async function inDemo(): Promise<boolean> {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return false;
  const { data: s } = await supabase.auth.getSession();
  return demoState(data.user.app_metadata, sessionClaims(s.session?.access_token)?.sessionId) !== "none";
}

/** Server actions that change keys, members, the account or the lock call this first. */
export async function refuseDemo(): Promise<void> {
  if (await inDemo()) throw new Error("That isn't available in a demo.");
}

export { sessionClaims };
