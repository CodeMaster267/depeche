/** True once the Supabase settings are in place (in Vercel, or in `.env.local` for development). */
export function isConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

/** The owner's email. Only this address can set Depeche up the first time. */
export function ownerEmail(): string {
  return (process.env.DEPECHE_OWNER_EMAIL ?? "").trim().toLowerCase();
}

/** How long an invite link works. */
export const INVITE_DAYS = 14;
