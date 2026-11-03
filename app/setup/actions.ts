"use server";

import { redirect } from "next/navigation";
import { isConfigured, ownerEmail } from "@/lib/config";
import { ensureAuthUser } from "@/lib/auth/prepare";
import { siteOrigin } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";
import { cleanEmail, cleanName } from "@/lib/validate";
import { TOO_MANY, allow, clientIp } from "@/lib/rate-limit";

export type SetupState = { error?: string; sentTo?: string } | undefined;

/**
 * First-time setup. Only the address in DEPECHE_OWNER_EMAIL is accepted, and the owner's family
 * is only created after they prove that address, by Google or by the emailed link.
 */
export async function startSetup(_: SetupState, form: FormData): Promise<SetupState> {
  if (!isConfigured() || !ownerEmail()) return { error: "Depeche isn't fully configured yet (owner email missing)." };
  const name = cleanName(form.get("name"));
  const family = cleanName(form.get("family"), 80);
  const email = cleanEmail(form.get("email"));
  const via = form.get("via");
  if (!name || !family || !email) return { error: "Fill in your name, your family's name and your email." };
  if (!(await allow(["invitePagePerIp", await clientIp()]))) return { error: TOO_MANY };

  const { data: taken } = await supabaseAdmin().rpc("app_owner_exists");
  if (taken) redirect("/sign-in");
  if (email !== ownerEmail()) return { error: "That isn't the owner's email address." };

  if (!(await ensureAuthUser(email, { display_name: name, family_name: family }))) {
    return { error: "Couldn't prepare your account. Try again." };
  }

  const supabase = await supabaseServer();
  const origin = await siteOrigin();
  if (via === "google") {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${origin}/auth/callback`, queryParams: { login_hint: email } },
    });
    if (error || !data.url) return { error: "Google sign-in isn't set up yet. Use the email link." };
    redirect(data.url);
  }
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: `${origin}/auth/confirm` },
  });
  if (error) return { error: "Couldn't send the email. Wait a minute and try again." };
  return { sentTo: email };
}
