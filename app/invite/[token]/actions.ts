"use server";

import { redirect } from "next/navigation";
import { isConfigured } from "@/lib/config";
import { ensureAuthUser } from "@/lib/auth/prepare";
import { friendly, siteOrigin } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";
import { hashToken } from "@/lib/tokens";
import { cleanUsername, passwordProblem } from "@/lib/validate";
import { TOO_MANY, allow, clientIp } from "@/lib/rate-limit";

export type InviteState = { error?: string; sentTo?: string } | undefined;

type Preview = { email: string; state: string };

async function openInvite(token: string): Promise<Preview | null> {
  const { data } = await supabaseAdmin().rpc("invite_preview", { p_token_hash: hashToken(token) });
  const row = (data as Preview[] | null)?.[0];
  return row && row.state === "valid" ? row : null;
}

/** Accept by choosing a username and password. The invite link itself is the proof. */
export async function acceptWithPassword(token: string, _: InviteState, form: FormData): Promise<InviteState> {
  if (!isConfigured()) return { error: "Depeche isn't connected to its database yet." };
  if (!(await allow(["invitePagePerIp", await clientIp()]))) return { error: TOO_MANY };
  const invite = await openInvite(token);
  if (!invite) return { error: "This invite has expired or was already used." };

  const rawUsername = String(form.get("username") ?? "").trim();
  const username = rawUsername ? cleanUsername(rawUsername) : null;
  if (rawUsername && !username) return { error: "Usernames are 3 to 32 letters, numbers, dots, dashes or underscores." };
  const password = String(form.get("password") ?? "");
  const problem = passwordProblem(password);
  if (problem) return { error: problem };

  const admin = supabaseAdmin();
  const userId = await ensureAuthUser(invite.email);
  if (!userId) return { error: "Couldn't create your account. Try again." };

  // Accept first: it refuses if this email already belongs to someone in Depeche, so an invite
  // link can never be used to set the password of an existing account.
  const { error } = await admin.rpc("accept_invite", { p_token_hash: hashToken(token), p_user: userId });
  if (error) return { error: friendly(error) };
  const { error: pwError } = await admin.auth.admin.updateUserById(userId, { password });
  if (pwError) return { error: "You're in, but that password couldn't be saved. Sign in with an email link and set one in Account." };
  if (username) {
    const { error: uErr } = await admin.rpc("set_username", { p_user: userId, p_username: username });
    if (uErr) return { error: `You're in, but ${friendly(uErr, "that username couldn't be saved.").toLowerCase()} Sign in with your email and pick another in Account.` };
  }

  const supabase = await supabaseServer();
  await supabase.auth.signInWithPassword({ email: invite.email, password });
  redirect("/");
}

/** Accept with Google or an emailed link: the person proves they own the invited address. */
export async function acceptWithProof(token: string, _: InviteState, form: FormData): Promise<InviteState> {
  if (!isConfigured()) return { error: "Depeche isn't connected to its database yet." };
  if (!(await allow(["invitePagePerIp", await clientIp()]))) return { error: TOO_MANY };
  const invite = await openInvite(token);
  if (!invite) return { error: "This invite has expired or was already used." };
  if (!(await ensureAuthUser(invite.email))) return { error: "Couldn't prepare your account. Try again." };

  const supabase = await supabaseServer();
  const origin = await siteOrigin();
  if (form.get("via") === "google") {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${origin}/auth/callback`, queryParams: { login_hint: invite.email } },
    });
    if (error || !data.url) return { error: "Google sign-in isn't available right now. Choose a password instead." };
    redirect(data.url);
  }
  if (!(await allow(["emailsPerAddress", invite.email]))) return { error: TOO_MANY };
  const { error } = await supabase.auth.signInWithOtp({
    email: invite.email,
    options: { shouldCreateUser: false, emailRedirectTo: `${origin}/auth/confirm` },
  });
  if (error) return { error: "Couldn't send the email. Choose a password instead, or try again in a minute." };
  return { sentTo: invite.email };
}
