import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { ownerEmail } from "@/lib/config";
import { supabaseAdmin } from "@/lib/supabase/admin";

export type FinishResult = "ok" | "not-invited";

/**
 * Runs after someone proves who they are with Google or an email link. People who already have a
 * profile go straight in. Otherwise, an open invite for their email turns into a profile, or, the
 * very first time, the owner's account is set up. Anyone else is signed out again.
 */
export async function finishSignIn(supabase: SupabaseClient, user: User): Promise<FinishResult> {
  const admin = supabaseAdmin();

  const { data: existing } = await admin.from("profiles").select("id").eq("id", user.id).maybeSingle();
  if (existing) return "ok";

  const { data: fam, error } = await admin.rpc("accept_pending_invite", { p_user: user.id });
  if (!error && fam) return "ok";

  const email = (user.email ?? "").toLowerCase();
  if (email && email === ownerEmail()) {
    const meta = user.user_metadata ?? {};
    const { error: e } = await admin.rpc("bootstrap_owner", {
      p_user: user.id,
      p_display_name: String(meta.display_name || "Hasan"),
      p_family_name: String(meta.family_name || "My family"),
    });
    if (!e) return "ok";
  }

  await supabase.auth.signOut();
  return "not-invited";
}
