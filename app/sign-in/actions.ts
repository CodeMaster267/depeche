"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { DEMO_COOKIE } from "@/lib/auth/demo-meta";
import { COOKIE_BASE } from "@/lib/lock/token";
import { isConfigured } from "@/lib/config";
import { finishSignIn } from "@/lib/auth/finish";
import { siteOrigin } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";
import { cleanEmail } from "@/lib/validate";
import { TOO_MANY, allow, blocked, clientIp, failed } from "@/lib/rate-limit";
import { demoDeviceHash, demoKeyHash, markDemoSession, normalDemoKey, sessionClaims } from "@/lib/auth/demo";

export type FormState = { error?: string; sentTo?: string } | undefined;

const NOT_READY = "Depeche isn't connected to its database yet.";

/** Username (or email) and password. Usernames are looked up on the server, never in the browser. */
export async function signInWithPassword(_: FormState, form: FormData): Promise<FormState> {
  if (!isConfigured()) return { error: NOT_READY };
  const who = String(form.get("identifier") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!who || !password) return { error: "Enter your username and password." };
  // Only wrong passwords count, so signing in correctly is never held up.
  const ip = await clientIp();
  const tries: [["signInPerAccount", string], ["signInPerIp", string]] = [["signInPerAccount", who], ["signInPerIp", ip]];
  if (await blocked(...tries)) return { error: TOO_MANY };

  let email = cleanEmail(who);
  if (!email) {
    const { data } = await supabaseAdmin().rpc("email_for_username", { p_username: who });
    email = typeof data === "string" ? data : null;
  }
  const wrong = { error: "That username or password isn't right." };
  if (!email) {
    await failed(...tries);
    return wrong;
  }

  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    await failed(...tries);
    return wrong;
  }
  if ((await finishSignIn(supabase, data.user)) !== "ok") return { error: "This account isn't part of a family yet." };

  // A temporary password from the admin works once, for a day, and then only to choose a new one.
  const { data: p } = await supabaseAdmin()
    .from("profiles")
    .select("must_change_password, temp_password_until")
    .eq("id", data.user.id)
    .maybeSingle<{ must_change_password: boolean; temp_password_until: string | null }>();
  if (p?.must_change_password && p.temp_password_until && new Date(p.temp_password_until) < new Date()) {
    await supabase.auth.signOut();
    return { error: "That temporary password has expired. Ask your family admin for a new one." };
  }
  redirect(p?.must_change_password ? "/new-password" : "/");
}

/**
 * Emails a sign-in link that also carries a six-digit code. The code matters on iPhone, where a
 * link from Mail may open in Safari rather than in the Depeche home-screen app.
 */
export async function sendEmailLink(_: FormState, form: FormData): Promise<FormState> {
  if (!isConfigured()) return { error: NOT_READY };
  const email = cleanEmail(form.get("email"));
  if (!email) return { error: "Enter a valid email address." };
  if (!(await allow(["emailsPerAddress", email], ["emailsPerIp", await clientIp()]))) return { error: TOO_MANY };
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
  const tries: [["codeGuesses", string], ["signInPerIp", string]] = [["codeGuesses", email], ["signInPerIp", await clientIp()]];
  if (await blocked(...tries)) return { error: TOO_MANY, sentTo: email };
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
  if (error || !data.user) {
    await failed(...tries);
    return { error: "That code didn't work. Check it, or send a new one.", sentTo: email };
  }
  if ((await finishSignIn(supabase, data.user)) !== "ok") redirect("/sign-in?error=not-invited");
  redirect("/");
}

/**
 * A one-time demo key the app owner handed out: signs into the owner's account in a demo session,
 * which can't open the family's API keys, members, the account page or Health, and ends when the
 * tab closes (or after 12 hours). Each key works once on each device. Wrong keys are rate limited per device and overall.
 */
export async function signInWithDemoKey(_: FormState, form: FormData): Promise<FormState> {
  if (!isConfigured()) return { error: NOT_READY };
  const word = normalDemoKey(form.get("demoKey"));
  if (!word) return { error: "Enter your demo key." };
  const device = String(form.get("device") ?? "");
  if (!/^[A-Za-z0-9-]{16,100}$/.test(device)) return { error: "The demo isn't available in this browser." };
  const tries: [["demoKeyPerIp", string], ["demoKeyAll", string]] = [["demoKeyPerIp", await clientIp()], ["demoKeyAll", "all"]];
  if (await blocked(...tries)) return { error: TOO_MANY };

  const admin = supabaseAdmin();
  // Each key works once on each device.
  const { data: ok } = await admin.rpc("use_demo_key_on_device", { p_hash: demoKeyHash(word), p_device: demoDeviceHash(device) });
  if (ok !== true) {
    await failed(...tries);
    return { error: "That demo key isn't right, or it was already used." };
  }
  const unavailable = { error: "The demo isn't available right now." };
  const { data: owner } = await admin.from("profiles").select("id").eq("is_app_owner", true).maybeSingle<{ id: string }>();
  if (!owner) return unavailable;
  const { data: found } = await admin.auth.admin.getUserById(owner.id);
  const email = found.user?.email;
  if (!email) return unavailable;
  const { data: link, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = link?.properties?.hashed_token;
  if (error || !tokenHash) return unavailable;

  const supabase = await supabaseServer();
  const { data, error: verifyError } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
  const sessionId = sessionClaims(data.session?.access_token)?.sessionId;
  if (verifyError || !data.user || !sessionId) return unavailable;
  try {
    await markDemoSession(data.user.id, sessionId);
    (await cookies()).set(DEMO_COOKIE, "1", COOKIE_BASE);
  } catch {
    await supabase.auth.signOut();
    return unavailable;
  }
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

/** Ends only this browser's session (a demo tab that closed), never the owner's other devices. */
export async function signOutThisTab(): Promise<void> {
  const supabase = await supabaseServer();
  await supabase.auth.signOut({ scope: "local" });
  (await cookies()).delete(DEMO_COOKIE);
  redirect("/sign-in");
}
