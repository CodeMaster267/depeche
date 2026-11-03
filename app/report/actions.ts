"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { friendly, requireMe } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { safeNext } from "@/lib/validate";

export type ReportState = { error?: string; ok?: string; sent?: string } | undefined;

const MIN_REPORT = 10;
const MAX_REPORT = 2000;

/**
 * Saves a bug report for the signed-in person. Who sent it comes from the session, never from the
 * form, and the database enforces the daily limit, so neither can be talked around.
 */
export async function sendReport(_: ReportState, form: FormData): Promise<ReportState> {
  const me = await requireMe();
  const body = String(form.get("body") ?? "").trim();
  if (body.length < MIN_REPORT) return { error: "Tell us a little more about what went wrong." };
  if (body.length > MAX_REPORT) return { error: `Keep it under ${MAX_REPORT} characters.` };
  const from = safeNext(form.get("from")).slice(0, 200);
  const ua = ((await headers()).get("user-agent") ?? "").slice(0, 400);

  const { data, error } = await supabaseAdmin().rpc("submit_bug_report", {
    p_actor: me.userId,
    p_body: body,
    p_page: from,
    p_user_agent: ua,
  });
  if (error) return { error: friendly(error, "Couldn't send that. Try again.") };
  revalidatePath("/report");
  return { ok: "Thanks, it's on its way. You'll see what happens to it below.", sent: String(data) };
}
