import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Keeps the free Supabase project awake. Supabase pauses free projects after about a week with no
 * activity, so this makes one tiny real request to the database API. Vercel calls it daily (see
 * vercel.json) and GitHub Actions calls it daily too (.github/workflows/keep-alive.yml), so either
 * one alone is enough. It reads nothing private and returns only ok / not ok.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { error } = await supabaseAdmin().from("families").select("id").limit(1);
    if (error) throw error;
    return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
