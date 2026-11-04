"use server";

import { revalidatePath } from "next/cache";
import { requireMe } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  PIN_PATTERN,
  TIMEOUTS,
  grantUnlock,
  hashPin,
  lockSession,
  readLock,
  registrationOptions,
  savePasskey,
  syncLockMeta,
  tryPin,
  type LockSession,
  type NewPasskey,
} from "@/lib/lock/server";

export type LockState = { error?: string; ok?: string } | undefined;

const LABELS = ["iPhone", "iPad", "Mac", "Android", "Windows", "This device"];

/** The person, signed in and (the proxy already made sure) unlocked. */
async function me(): Promise<LockSession> {
  await requireMe();
  const s = await lockSession();
  if (!s) throw new Error("Not signed in");
  return s;
}

/**
 * Changing or removing a lock that's already on needs the current PIN, so someone who picks up an
 * unlocked phone can't quietly take the lock off. Someone who just signed in (after forgetting
 * their PIN) has already proved who they are.
 */
async function currentPinProblem(s: LockSession, form: FormData): Promise<string | null> {
  if (!s.meta || s.fresh) return null;
  const pin = String(form.get("current") ?? "");
  if (!pin) return "Enter your current PIN.";
  const result = await tryPin(s, pin);
  if (result.ok) return null;
  return result.signedOut ? result.error : result.error.replace("Wrong PIN", "Wrong current PIN");
}

/** Turns the lock on, or changes the PIN. */
export async function savePin(_: LockState, form: FormData): Promise<LockState> {
  const s = await me();
  const pin = String(form.get("pin") ?? "");
  if (!PIN_PATTERN.test(pin)) return { error: "Your PIN must be 4 to 8 digits." };
  if (pin !== String(form.get("confirm") ?? "")) return { error: "The two PINs don't match." };
  if (/^(\d)\1+$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin)) {
    return { error: "That PIN is too easy to guess. Try another." };
  }
  const problem = await currentPinProblem(s, form);
  if (problem) return { error: problem };

  const existing = await readLock(s.userId);
  const timeout = existing?.timeout_seconds ?? Number(form.get("timeout") ?? 300);
  const { error } = await supabaseAdmin()
    .from("app_locks")
    .upsert({
      owner_id: s.userId,
      pin_hash: await hashPin(pin),
      pin_length: pin.length,
      timeout_seconds: (TIMEOUTS as readonly number[]).includes(timeout) ? timeout : 300,
      failed_tries: 0,
      wait_until: null,
      updated_at: new Date().toISOString(),
    });
  if (error) return { error: "Couldn't save your PIN. Try again." };
  const meta = await syncLockMeta(s.userId);
  await grantUnlock(s, meta);
  revalidatePath("/account");
  return { ok: existing ? "PIN changed." : "App lock is on." };
}

export async function setLockTimeout(seconds: number): Promise<LockState> {
  const s = await me();
  if (!(TIMEOUTS as readonly number[]).includes(seconds)) return { error: "Pick one of the options." };
  const { error } = await supabaseAdmin()
    .from("app_locks")
    .update({ timeout_seconds: seconds, updated_at: new Date().toISOString() })
    .eq("owner_id", s.userId);
  if (error) return { error: "Couldn't save that." };
  const meta = await syncLockMeta(s.userId);
  await grantUnlock(s, meta);
  revalidatePath("/account");
  return { ok: "Saved." };
}

/** Turns the lock off everywhere, and forgets every device's Face ID / Touch ID. */
export async function turnOffLock(_: LockState, form: FormData): Promise<LockState> {
  const s = await me();
  const problem = await currentPinProblem(s, form);
  if (problem) return { error: problem };
  const admin = supabaseAdmin();
  await admin.from("lock_passkeys").delete().eq("owner_id", s.userId);
  const { error } = await admin.from("app_locks").delete().eq("owner_id", s.userId);
  if (error) return { error: "Couldn't turn it off. Try again." };
  await syncLockMeta(s.userId);
  await grantUnlock(s, null);
  revalidatePath("/account");
  return { ok: "App lock is off." };
}

/** Step 1 of setting up Face ID / Touch ID on this device. */
export async function passkeyOptions() {
  const s = await me();
  if (!s.meta) return { error: "Turn on the app lock with a PIN first." };
  const { profile } = await requireMe();
  return { options: await registrationOptions(s, profile.display_name) };
}

/** Step 2: the device made a passkey; check it and keep it. */
export async function addPasskey(body: NewPasskey, label: string): Promise<LockState> {
  const s = await me();
  if (!s.meta) return { error: "Turn on the app lock with a PIN first." };
  const problem = await savePasskey(s, body, LABELS.includes(label) ? label : "This device");
  if (problem) return { error: problem };
  const meta = await syncLockMeta(s.userId);
  await grantUnlock(s, meta);
  revalidatePath("/account");
  return { ok: "Done. You can unlock Depeche with it now." };
}

export async function removePasskey(id: string): Promise<LockState> {
  const s = await me();
  const { error } = await supabaseAdmin().from("lock_passkeys").delete().eq("owner_id", s.userId).eq("id", id);
  if (error) return { error: "Couldn't remove it." };
  const meta = await syncLockMeta(s.userId);
  await grantUnlock(s, meta);
  revalidatePath("/account");
  return { ok: "Removed." };
}
