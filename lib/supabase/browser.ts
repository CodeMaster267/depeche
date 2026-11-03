import { createBrowserClient } from "@supabase/ssr";

/** Supabase client for code running in the browser. Uses the public anon key only. */
export function supabaseBrowser() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
