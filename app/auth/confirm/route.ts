import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { finishSignIn } from "@/lib/auth/finish";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Sign-in links from emails land here. The link carries a hashed token rather than a browser-bound
 * code, so it works even when opened in a different browser from the one that asked for it.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get("token_hash");
  const type = (url.searchParams.get("type") ?? "email") as EmailOtpType;
  const back = (path: string) => NextResponse.redirect(new URL(path, url.origin));
  if (!tokenHash) return back("/sign-in?error=link");

  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
  if (error || !data.user) return back("/sign-in?error=link");
  return (await finishSignIn(supabase, data.user)) === "ok" ? back("/") : back("/sign-in?error=not-invited");
}
