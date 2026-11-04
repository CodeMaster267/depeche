import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Runs before every page. Keeps the Supabase session fresh (so people stay signed in on their
 * devices) and sends anyone who isn't signed in to the sign-in page. Pages still check the
 * profile themselves; this is only the first gate.
 */
const PUBLIC = ["/sign-in", "/setup", "/invite/", "/auth/", "/api/keep-alive", "/api/cleanup", "/api/research/step"];

export async function proxy(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });
  const { data } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  if (!data.user && !PUBLIC.some((p) => path === p || path.startsWith(p))) {
    const to = request.nextUrl.clone();
    to.pathname = "/sign-in";
    to.search = "";
    const redirect = NextResponse.redirect(to);
    for (const c of response.cookies.getAll()) redirect.cookies.set(c);
    return redirect;
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico|webmanifest|txt)$).*)"],
};
