import { NextResponse, type NextRequest } from "next/server";
import { finishSignIn } from "@/lib/auth/finish";
import { supabaseServer } from "@/lib/supabase/server";

/** Google sends people back here with a one-time code. */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const back = (path: string) => NextResponse.redirect(new URL(path, url.origin));
  if (!code) return back("/sign-in?error=link");

  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) return back("/sign-in?error=link");
  return (await finishSignIn(supabase, data.user)) === "ok" ? back("/") : back("/sign-in?error=not-invited");
}
