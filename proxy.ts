import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import {
  COOKIE_BASE,
  SETTINGS_COOKIE,
  UNLOCK_COOKIE,
  UNLOCK_COOKIE_MAX_AGE,
  lockMeta,
  nowSeconds,
  sessionClaims,
  settingsCookieValue,
  sign,
  unlockState,
  windowFor,
} from "@/lib/lock/token";

/**
 * Runs before every page. Keeps the Supabase session fresh (so people stay signed in on their
 * devices) and sends anyone who isn't signed in to the sign-in page. Pages still check the
 * profile themselves; this is only the first gate.
 */
const PUBLIC = ["/sign-in", "/setup", "/invite/", "/auth/", "/api/keep-alive", "/api/cleanup", "/sw.js", "/api/research/step"];
/** Reachable while the app lock is on and this device is locked. */
const LOCK_FREE = [...PUBLIC, "/lock", "/api/lock/"];
const under = (path: string, list: string[]) => list.some((p) => path === p || path.startsWith(p));

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
  if (!data.user && !under(path, PUBLIC)) {
    const to = request.nextUrl.clone();
    to.pathname = "/sign-in";
    to.search = "";
    const redirect = NextResponse.redirect(to);
    for (const c of response.cookies.getAll()) redirect.cookies.set(c);
    return redirect;
  }
  if (data.user) {
    const { data: s } = await supabase.auth.getSession();
    return applyLock(request, response, s.session?.access_token, data.user.id, data.user.app_metadata, path);
  }
  if (request.cookies.has(SETTINGS_COOKIE)) response.cookies.delete(SETTINGS_COOKIE);
  return response;
}

/**
 * The app lock (PIN, Face ID). With it on, a locked device reaches only the lock screen: pages
 * redirect there, and anything else (server actions, API calls) is refused. The page itself also
 * covers the screen when it locks, so nothing shows while this catches up.
 */
async function applyLock(
  request: NextRequest,
  response: NextResponse,
  accessToken: string | undefined,
  userId: string,
  appMetadata: Record<string, unknown> | undefined,
  path: string,
): Promise<NextResponse> {
  const meta = lockMeta(appMetadata);
  // Tell the page the person's lock settings, so it can lock itself after time without use.
  const want = meta ? settingsCookieValue(meta) : null;
  if (want && request.cookies.get(SETTINGS_COOKIE)?.value !== want) {
    response.cookies.set(SETTINGS_COOKIE, want, { ...COOKIE_BASE, maxAge: UNLOCK_COOKIE_MAX_AGE });
  } else if (!want && request.cookies.has(SETTINGS_COOKIE)) {
    response.cookies.delete(SETTINGS_COOKIE);
  }
  if (!meta || under(path, LOCK_FREE)) return response;

  const session = sessionClaims(accessToken);
  const state = unlockState(request.cookies.get(UNLOCK_COOKIE)?.value, userId, session);
  if (state.unlocked) {
    // Signing in on this device a moment ago counts as unlocking it.
    if (state.fresh && session) {
      const e = nowSeconds() + windowFor(meta) + 60;
      response.cookies.set(UNLOCK_COOKIE, sign({ u: userId, s: session.sessionId, e }), {
        ...COOKIE_BASE,
        httpOnly: true,
        maxAge: UNLOCK_COOKIE_MAX_AGE,
      });
    }
    return response;
  }

  const isPage = request.method === "GET" && !path.startsWith("/api/");
  const locked = isPage
    ? NextResponse.redirect(lockUrl(request))
    : NextResponse.json({ error: "Depeche is locked. Unlock it to continue.", locked: true }, { status: 423 });
  for (const c of response.cookies.getAll()) locked.cookies.set(c);
  return locked;
}

function lockUrl(request: NextRequest): URL {
  const to = request.nextUrl.clone();
  const from = request.nextUrl.clone();
  from.searchParams.delete("_rsc");
  const back = from.pathname + from.search;
  to.pathname = "/lock";
  to.search = back && back !== "/" ? `?next=${encodeURIComponent(back)}` : "";
  return to;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico|webmanifest|txt)$).*)"],
};
