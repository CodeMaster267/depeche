import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Makes sure a sign-in account exists for an email, so that Google or an email link can be used
 * while open sign-up stays switched off in Supabase. A bare account grants nothing: Depeche only
 * lets someone in once they have proved the email and an invite (or owner setup) matches it.
 */
export async function ensureAuthUser(email: string, metadata: Record<string, string> = {}): Promise<string | null> {
  const admin = supabaseAdmin();
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: metadata });
  if (!error && data.user) return data.user.id;

  // Already exists: find it. Fine at Depeche's size (under 30 people).
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const found = list?.users.find((u) => u.email?.toLowerCase() === email);
  if (!found) return null;
  if (Object.keys(metadata).length) {
    await admin.auth.admin.updateUserById(found.id, { user_metadata: { ...found.user_metadata, ...metadata } });
  }
  return found.id;
}
