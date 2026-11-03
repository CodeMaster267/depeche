"use server";

import { revalidatePath } from "next/cache";
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

export async function changePassword(_: AccountState, form: FormData): Promise<AccountState> {
  await requireMe();
  const password = String(form.get("password") ?? "");
  const problem = passwordProblem(password);
  if (problem) return { error: problem };
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { error: error.code === "same_password" ? "That's already your password." : "Couldn't change your password. Try a different one." };
  return { ok: "Password changed." };
}
