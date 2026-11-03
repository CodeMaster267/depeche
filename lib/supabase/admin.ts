import "server-only";
import { createClient } from "@supabase/supabase-js";
import { serviceRoleKey } from "@/lib/config";

/**
 * Supabase client with the service role. Bypasses row-level security, so only server code that
 * has already checked who is signed in may use it, and only for the actions the privacy rules
 * reserve for the server (invites, roles, caps, accounts).
 */
export function supabaseAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceRoleKey()!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
