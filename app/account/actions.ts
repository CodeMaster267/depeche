"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { friendly, requireMe } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";
import { cleanName, cleanUsername, passwordProblem } from "@/lib/validate";

export type AccountState = { error?: string; ok?: string } | undefined;

export async function saveProfile(_: AccountState, form: FormData): Promise<AccountState> {
  const me = await requireMe();
  const name = cleanName(form.get("name"));
  if (!name) return { error: "Enter your name." };
  const raw = String(form.get("username") ?? "").trim();
  const username = raw ? cleanUsername(raw) : null;
  if (raw && !username) return { error: "Usernames are 3 to 32 letters, numbers, dots, dashes or underscores." };

  // Your own name is yours to change, so it goes through row-level security as you.
  const supabase = await supabaseServer();
  const { error: nameErr } = await supabase.from("profiles").update({ display_name: name }).eq("id", me.userId);
  if (nameErr) return { error: "Couldn't save your name." };

  const { error } = await supabaseAdmin().rpc("set_username", { p_user: me.userId, p_username: username ?? "" });
  if (error) return { error: friendly(error, "Couldn't save that username.") };
  revalidatePath("/", "layout");
  return { ok: "Saved." };
}

/** Also used on the page people land on after signing in with a temporary password. */
export async function changePassword(_: AccountState, form: FormData): Promise<AccountState> {
  const me = await requireMe({ allowTempPassword: true });
  const password = String(form.get("password") ?? "");
  const problem = passwordProblem(password);
  if (problem) return { error: problem };
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { error: error.code === "same_password" ? "That's already your password." : "Couldn't change your password. Try a different one." };
  await supabaseAdmin().rpc("password_changed", { p_user: me.userId });
  if (me.profile.must_change_password) redirect("/");
  return { ok: "Password changed." };
}

/** Whether your chats are deleted after a month without use. Yours alone to change. */
export async function setKeepChats(keep: boolean): Promise<void> {
  const me = await requireMe();
  const supabase = await supabaseServer();
  await supabase.from("profiles").update({ keep_chats: keep }).eq("id", me.userId);
  revalidatePath("/account");
}

/** Whether your family admin can see your chat titles (never what's in them). Yours to decide. */
export async function setShareTitles(share: boolean): Promise<void> {
  const me = await requireMe();
  await (await supabaseServer()).from("profiles").update({ share_titles: share }).eq("id", me.userId);
  revalidatePath("/account");
}

/** Ends every session you have, on every device, including this one. */
export async function signOutEverywhere(): Promise<void> {
  const me = await requireMe({ allowTempPassword: true });
  await supabaseAdmin().rpc("sign_out_everywhere", { p_actor: me.userId, p_person: me.userId });
  await (await supabaseServer()).auth.signOut({ scope: "local" });
  redirect("/sign-in");
}

/**
 * Permanently deletes all your chats (with every message in them) and all your memories. This runs
 * with your own session, so row-level security makes sure only your own rows can go. Backups keep
 * them for at most 30 more days, then they are gone everywhere.
 */
export async function deleteEverything(_: AccountState, form: FormData): Promise<AccountState> {
  const me = await requireMe();
  if (String(form.get("confirm") ?? "").trim().toLowerCase() !== "delete") {
    return { error: "Type delete to confirm." };
  }
  const db = await supabaseServer();
  const [chats, memories] = await Promise.all([
    db.from("chats").delete().eq("owner_id", me.userId),
    db.from("memories").delete().eq("owner_id", me.userId),
  ]);
  if (chats.error || memories.error) return { error: "Couldn't delete everything. Try again." };
  revalidatePath("/", "layout");
  return { ok: "All your chats and memories are deleted." };
}
