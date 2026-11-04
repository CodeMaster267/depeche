import { NextResponse } from "next/server";
import { getMe } from "@/lib/auth/session";
import { allow } from "@/lib/rate-limit";
import { pushTo } from "@/lib/push/server";

/** Sends a test notification to every device where this person turned notifications on. */
export async function POST() {
  const me = await getMe();
  if (!me) return NextResponse.json({ error: "Sign in again first." }, { status: 401 });
  if (!(await allow(["pushChanges", me.userId]))) {
    return NextResponse.json({ error: "Try again in a little while." }, { status: 429 });
  }
  const sent = await pushTo(me.userId, {
    title: "Depeche",
    body: "Notifications work. You'll get one like this when an answer is ready.",
    url: "/account",
    tag: "test",
  });
  return NextResponse.json({ sent });
}
