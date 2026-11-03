// Writes .env.local pointing the app at the local Supabase started by `npm run db:start`.
// These are Supabase's fixed local-development keys, not real secrets.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const status = JSON.parse(execFileSync("npx", ["supabase", "status", "-o", "json"], { encoding: "utf8" }));
const env = {
  NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: status.PUBLISHABLE_KEY ?? status.ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: status.SECRET_KEY ?? status.SERVICE_ROLE_KEY,
  MAILPIT_URL: status.MAILPIT_URL ?? status.INBUCKET_URL,
  DEPECHE_OWNER_EMAIL: "hasan@example.com",
  // Replies come from a built-in stand-in, so tests never call (or pay) a real AI provider.
  DEPECHE_FAKE_AI: "1",
};
writeFileSync(".env.local", Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
console.log("Wrote .env.local for the local Supabase.");
