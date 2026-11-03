const REQUIRED = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DEPECHE_OWNER_EMAIL",
] as const;

function present(name: (typeof REQUIRED)[number]): boolean {
  // Spelled out so Next.js can inline the public ones at build time.
  const values = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    DEPECHE_OWNER_EMAIL: process.env.DEPECHE_OWNER_EMAIL,
  };
  return Boolean(values[name]?.trim());
}

/**
 * Names (never values) of the settings still missing in Vercel (or `.env.local` for development).
 * Shown on the sign-in page so a half-finished setup explains itself instead of crashing.
 */
export function missingSettings(): string[] {
  return REQUIRED.filter((n) => !present(n));
}

/** True once every setting Depeche needs is in place. */
export function isConfigured(): boolean {
  return missingSettings().length === 0;
}

/** The owner's email. Only this address can set Depeche up the first time. */
export function ownerEmail(): string {
  return (process.env.DEPECHE_OWNER_EMAIL ?? "").trim().toLowerCase();
}

/** How long an invite link works. */
export const INVITE_DAYS = 14;
