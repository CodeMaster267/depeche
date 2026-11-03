import "server-only";
import { headers } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Rate limits, counted in the database so they hold across every server instance. Each rule is a
 * number of attempts per window. Keys combine the rule with who is asking (a person, an email
 * address or the device's internet address).
 */
export const LIMITS = {
  /** Wrong passwords for one username or email. */
  signInPerAccount: { limit: 10, seconds: 15 * 60 },
  /** Wrong passwords or codes from one internet address. */
  signInPerIp: { limit: 30, seconds: 15 * 60 },
  /** Emailed links or codes to one address. */
  emailsPerAddress: { limit: 5, seconds: 60 * 60 },
  /** Emailed links or codes from one internet address. */
  emailsPerIp: { limit: 15, seconds: 60 * 60 },
  /** Guesses at an emailed code for one address. */
  codeGuesses: { limit: 10, seconds: 15 * 60 },
  /** Opening invites and first-time setup from one internet address. */
  invitePagePerIp: { limit: 30, seconds: 60 * 60 },
  /** Invites an admin creates. */
  invitesPerAdmin: { limit: 20, seconds: 24 * 60 * 60 },
  /** Temporary passwords and sign-outs an admin issues. */
  adminActions: { limit: 20, seconds: 60 * 60 },
  /** Provider keys an admin tries (each is checked with the provider). */
  keyChecks: { limit: 10, seconds: 60 * 60 },
  /** Messages to the AI, per person. */
  messagesPerMinute: { limit: 12, seconds: 60 },
  messagesPerDay: { limit: 400, seconds: 24 * 60 * 60 },
  /** Chat summaries (auto-compaction and "Redo summary"), per person. */
  summariesPerHour: { limit: 30, seconds: 60 * 60 },
  /** Voice requests (listening and reading aloud), per person. */
  voicePerMinute: { limit: 30, seconds: 60 },
  /** Bug reports, per person. */
  bugReportsPerDay: { limit: 5, seconds: 24 * 60 * 60 },
} as const;

export type Rule = keyof typeof LIMITS;

/**
 * The browser tests run many sign-ins and messages at once from one machine, so locally (and only
 * with the fake AI, which is refused on Vercel) limits are 50 times higher. Wrong passwords per
 * account keep their real limit so the tests can prove it.
 */
function limitFor(rule: Rule): number {
  const testing = process.env.DEPECHE_FAKE_AI === "1" && !process.env.VERCEL;
  return testing && rule !== "signInPerAccount" ? LIMITS[rule].limit * 50 : LIMITS[rule].limit;
}

const keyFor = (rule: Rule, who: string) => `${rule}:${who.toLowerCase()}`.slice(0, 300);

/** The device's internet address, as Vercel reports it. */
export async function clientIp(): Promise<string> {
  const h = await headers();
  return (h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0] ?? "unknown").trim().slice(0, 64);
}

/**
 * Counts one attempt against each `[rule, who]` pair and returns true only if all are within their
 * limits. If the database can't be reached, it allows the attempt rather than locking everyone out.
 */
export async function allow(...checks: [Rule, string][]): Promise<boolean> {
  const admin = supabaseAdmin();
  const results = await Promise.all(
    checks.map(async ([rule, who]) => {
      const { data, error } = await admin.rpc("rate_limit_hit", {
        p_key: keyFor(rule, who),
        p_limit: limitFor(rule),
        p_window_seconds: LIMITS[rule].seconds,
      });
      return error ? true : data !== false;
    }),
  );
  return results.every(Boolean);
}

/** True if any of the pairs has already used up its attempts. Counts nothing new. */
export async function blocked(...checks: [Rule, string][]): Promise<boolean> {
  const admin = supabaseAdmin();
  const used = await Promise.all(
    checks.map(async ([rule, who]) => {
      const { data } = await admin.rpc("rate_limit_used", { p_key: keyFor(rule, who), p_window_seconds: LIMITS[rule].seconds });
      return Number(data ?? 0) >= limitFor(rule);
    }),
  );
  return used.some(Boolean);
}

/** Counts a failure (a wrong password or code) against each pair. */
export async function failed(...checks: [Rule, string][]): Promise<void> {
  await allow(...checks);
}

export const TOO_MANY = "Too many tries. Wait a few minutes and try again.";
