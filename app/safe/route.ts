import { NextResponse, type NextRequest } from "next/server";
import { SAFE_COOKIE } from "@/lib/design/load";

/**
 * Safe mode, for when a look ever goes wrong: opening /safe shows standard Depeche on this device
 * until it's turned off on My look. Part of the protected core, so no design can hide it.
 */
export function GET(req: NextRequest) {
  const res = NextResponse.redirect(new URL("/design?safe=1", req.url));
  res.cookies.set(SAFE_COOKIE, "1", { path: "/", httpOnly: true, sameSite: "lax", secure: !!process.env.VERCEL, maxAge: 60 * 60 * 24 * 365 });
  return res;
}
