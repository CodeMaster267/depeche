import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";

export type Profile = {
  id: string;
  family_id: string;
  role: "member" | "admin";
  is_app_owner: boolean;
  display_name: string;
  username: string | null;
  monthly_cap_usd: string;
  no_spend_limit: boolean;
  share_titles: boolean;
  /** Signed in with a temporary password from their admin, so must choose their own first. */
  must_change_password: boolean;
};

export type Me = { userId: string; email: string; profile: Profile };

/** The signed-in person and their profile, or null. Checked with Supabase on every request. */
export const getMe = cache(async (): Promise<Me | null> => {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, family_id, role, is_app_owner, display_name, username, monthly_cap_usd, no_spend_limit, share_titles, must_change_password")
    .eq("id", data.user.id)
    .maybeSingle<Profile>();
  if (!profile) return null;
  return { userId: data.user.id, email: data.user.email ?? "", profile };
});

/**
 * The signed-in person, or a redirect to sign in. Someone still on a temporary password is sent to
 * choose their own first, except on the page where they do that.
 */
export async function requireMe({ allowTempPassword = false } = {}): Promise<Me> {
  const me = await getMe();
  if (!me) redirect("/sign-in");
  if (me.profile.must_change_password && !allowTempPassword) redirect("/new-password");
  return me;
}

/** The address people reach this deployment on, for links in emails and invites. */
export async function siteOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

/** Error text from our database functions is written for people; anything else is not. */
export function friendly(error: { code?: string; message?: string } | null, fallback = "Something went wrong. Try again."): string {
  if (error?.code === "P0001" && error.message) return error.message + ".";
  if (error?.code === "23505" && /username/.test(error.message ?? "")) return "That username is taken.";
  return fallback;
}
