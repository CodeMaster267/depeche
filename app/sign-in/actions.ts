"use server";

import { redirect } from "next/navigation";
import { isConfigured } from "@/lib/config";
import { finishSignIn } from "@/lib/auth/finish";
import { siteOrigin } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";
import { cleanEmail } from "@/lib/validate";

export type FormState = { error?: string; sentTo?: string } | undefined;

const NOT_READY = "Depeche isn't connected to its database yet.";

/** Username (or email) and password. Usernames are looked up on the server, never in the browser. */
export async function signInWithPassword(_: FormState, form: FormData): Promise<FormState> {
  if (!isConfigured()) return { error: NOT_READY };
  const who = String(form.get("identifier") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!who || !password) return { error: "Enter your username and password." };

  let email = cleanEmail(who);
  if (!email) {
    const { data } = await supabaseAdmin().rpc("email_for_username", { p_username: who });
    email = typeof data === "string" ? data : null;
  }
  const wrong = { error: "That username or password isn't right." };
  if (!email) return wrong;

  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) return wrong;
  if ((await finishSignIn(supabase, data.user)) !== "ok") return { error: "This account isn't part of a family yet." };
  redirect("/");
}

/**
 * Emails a sign-in link that also carries a six-digit code. The code matters on iPhone, where a
 * link from Mail may open in Safari rather than in the Depeche home-screen app.
 */
export async function sendEmailLink(_: FormState, form: FormData): Promise<FormState> {
  if (!isConfigured()) return { error: NOT_READY };
  const email = cleanEmail(form.get("email"));
  if (!email) return { error: "Enter a valid email address." };
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: `${await siteOrigin()}/auth/confirm` },
  });
  // Say the same thing whether or not the address has an account, so the form can't be used to
  // find out who is in Depeche. Only rate limits are worth reporting.
  if (error && error.status === 429) return { error: "Too many emails. Wait a minute and try again." };
  return { sentTo: email };
}

export async function verifyEmailCode(_: FormState, form: FormData): Promise<FormState> {
  if (!isConfigured()) return { error: NOT_READY };
  const email = cleanEmail(form.get("email"));
  const token = String(form.get("code") ?? "").replace(/\D/g, "");
  if (!email || token.length < 6) return { error: "Enter the code from the email.", sentTo: email ?? undefined };
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
  if (error || !data.user) return { error: "That code didn't work. Check it, or send a new one.", sentTo: email };
  if ((await finishSignIn(supabase, data.user)) !== "ok") redirect("/sign-in?error=not-invited");
  redirect("/");
}

export async function signInWithGoogle(): Promise<void> {
  if (!isConfigured()) redirect("/sign-in?error=not-ready");
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${await siteOrigin()}/auth/callback` },
  });
  if (error || !data.url) redirect("/sign-in?error=google");
  redirect(data.url);
}

export async function signOut(): Promise<void> {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  redirect("/sign-in");
}
