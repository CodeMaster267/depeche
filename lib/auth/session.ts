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
};

export type Me = { userId: string; email: string; profile: Profile };

/** The signed-in person and their profile, or null. Checked with Supabase on every request. */
export const getMe = cache(async (): Promise<Me | null> => {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, family_id, role, is_app_owner, display_name, username, monthly_cap_usd")
    .eq("id", data.user.id)
    .maybeSingle<Profile>();
  if (!profile) return null;
  return { userId: data.user.id, email: data.user.email ?? "", profile };
});

export async function requireMe(): Promise<Me> {
  const me = await getMe();
  if (!me) redirect("/sign-in");
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
