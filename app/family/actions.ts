"use server";

import { revalidatePath } from "next/cache";
import { INVITE_DAYS } from "@/lib/config";
import { friendly, requireMe, siteOrigin } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { newInviteToken, newTempPassword } from "@/lib/tokens";
import { cleanEmail, cleanName } from "@/lib/validate";
import { TOO_MANY, allow } from "@/lib/rate-limit";
import { encryptSecret, toBytea } from "@/lib/crypto";
import { listKeyModels } from "@/lib/ai/providers";
import type { Provider } from "@/lib/ai/models";

export type ActionState = { error?: string; ok?: string; link?: string; password?: string } | undefined;

async function makeInvite(actor: string, family: string, name: string, email: string, role: "member" | "admin") {
  if (!(await allow(["invitesPerAdmin", actor]))) return { error: TOO_MANY };
  const { token, hash } = newInviteToken();
  const expires = new Date(Date.now() + INVITE_DAYS * 86_400_000).toISOString();
  const { error } = await supabaseAdmin().rpc("create_invite", {
    p_actor: actor,
    p_family: family,
    p_email: email,
    p_display_name: name,
    p_role: role,
    p_token_hash: hash,
    p_expires_at: expires,
  });
  if (error) return { error: friendly(error) };
  return { link: `${await siteOrigin()}/invite/${token}` };
}

export async function inviteMember(_: ActionState, form: FormData): Promise<ActionState> {
  const me = await requireMe();
  const name = cleanName(form.get("name"));
  const email = cleanEmail(form.get("email"));
  if (!name || !email) return { error: "Enter their name and email address." };
  const res = await makeInvite(me.userId, me.profile.family_id, name, email, "member");
  revalidatePath("/family");
  return "link" in res ? { ...res, ok: `Invite for ${name} is ready. Send them this link:` } : res;
}

export async function createFamily(_: ActionState, form: FormData): Promise<ActionState> {
  const me = await requireMe();
  const family = cleanName(form.get("family"), 80);
  const name = cleanName(form.get("name"));
  const email = cleanEmail(form.get("email"));
  if (!family || !name || !email) return { error: "Enter the family's name, and its admin's name and email." };
  const admin = supabaseAdmin();
  const { data: famId, error } = await admin.rpc("create_family", { p_actor: me.userId, p_name: family });
  if (error || !famId) return { error: friendly(error) };
  const res = await makeInvite(me.userId, famId as string, name, email, "admin");
  revalidatePath("/family");
  return "link" in res ? { ...res, ok: `${family} is ready. Send ${name} this link to become its admin:` } : res;
}

export async function revokeInvite(inviteId: string): Promise<void> {
  const me = await requireMe();
  await supabaseAdmin().rpc("revoke_invite", { p_actor: me.userId, p_invite: inviteId });
  revalidatePath("/family");
}

export async function setCap(memberId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const me = await requireMe();
  const cap = Number(String(form.get("cap") ?? "").replace(/[$,\s]/g, ""));
  if (!Number.isFinite(cap) || cap < 0 || cap > 100000) return { error: "Enter an amount in dollars." };
  const { error } = await supabaseAdmin().rpc("set_member_cap", {
    p_actor: me.userId,
    p_member: memberId,
    p_cap: Math.round(cap * 100) / 100,
  });
  if (error) return { error: friendly(error) };
  revalidatePath("/family");
  return { ok: "Saved." };
}

/**
 * Gives a member a one-time temporary password. The database checks the admin may do this, logs
 * it, signs the member out everywhere and makes them choose their own password when they next
 * sign in. The temporary password is shown to the admin once and never stored by Depeche.
 */
export async function resetPassword(memberId: string): Promise<ActionState> {
  const me = await requireMe();
  if (!(await allow(["adminActions", me.userId]))) return { error: TOO_MANY };
  const admin = supabaseAdmin();
  const { error: denied } = await admin.rpc("start_password_reset", { p_actor: me.userId, p_member: memberId });
  if (denied) return { error: friendly(denied) };
  const password = newTempPassword();
  const { error } = await admin.auth.admin.updateUserById(memberId, { password });
  if (error) return { error: "Couldn't set a temporary password. Try again." };
  revalidatePath("/family");
  return {
    password,
    ok: "Give them this temporary password in person. It works for one day, and they'll choose their own when they sign in.",
  };
}

/** Signs a member out on every device. */
export async function signOutMember(memberId: string): Promise<ActionState> {
  const me = await requireMe();
  if (!(await allow(["adminActions", me.userId]))) return { error: TOO_MANY };
  const { error } = await supabaseAdmin().rpc("sign_out_everywhere", { p_actor: me.userId, p_person: memberId });
  if (error) return { error: friendly(error) };
  revalidatePath("/family");
  return { ok: "Signed out on all their devices." };
}

/** Makes a member the family's backup admin, or removes an admin. */
export async function setAdmin(memberId: string, makeAdmin: boolean): Promise<ActionState> {
  const me = await requireMe();
  const { error } = await supabaseAdmin().rpc("set_admin", { p_actor: me.userId, p_member: memberId, p_admin: makeAdmin });
  if (error) return { error: friendly(error) };
  revalidatePath("/family");
  revalidatePath("/", "layout");
  return { ok: makeAdmin ? "They're now a backup admin." : "They're no longer an admin." };
}

const PROVIDER_IDS = ["anthropic", "openai", "google", "groq"] as const;

/**
 * Saves a family's provider key. It is checked with the provider, encrypted here on the server,
 * and stored by a database function that confirms the person is a family admin. It is never sent
 * back to any browser; admins see only its last four characters.
 */
export async function saveProviderKey(provider: string, _: ActionState, form: FormData): Promise<ActionState> {
  const me = await requireMe();
  if (!PROVIDER_IDS.includes(provider as Provider)) return { error: "Unknown provider." };
  if (me.profile.role !== "admin") return { error: "Only a family admin can add keys." };
  if (!(await allow(["keyChecks", me.userId]))) return { error: TOO_MANY };
  const key = String(form.get("key") ?? "").trim();
  if (key.length < 20 || key.length > 400 || /\s/.test(key)) return { error: "That doesn't look like a key. Copy it again." };
  const usable = await listKeyModels(provider as Provider, key);
  if (!usable) {
    return { error: "The provider didn't accept that key. Check it's copied in full and that billing is set up." };
  }
  const { error } = await supabaseAdmin().rpc("save_provider_key", {
    p_actor: me.userId,
    p_provider: provider,
    p_ciphertext: toBytea(encryptSecret(key)),
    p_last4: key.slice(-4),
  });
  if (error) return { error: friendly(error) };
  await supabaseAdmin().rpc("set_key_models", { p_family: me.profile.family_id, p_provider: provider, p_models: usable });
  revalidatePath("/family");
  revalidatePath("/");
  return { ok: "Key saved. Its models are ready for everyone in your family." };
}

export async function removeProviderKey(provider: string): Promise<void> {
  const me = await requireMe();
  await supabaseAdmin().rpc("remove_provider_key", { p_actor: me.userId, p_provider: provider });
  revalidatePath("/family");
  revalidatePath("/");
}
