import { PROVIDER_NAME } from "@/lib/ai/models";
/** What the Health screen reads, and the plain-language alerts it raises. */
export type FamilyProvider = {
  provider: string;
  models: string[] | null;
  checked_at: string | null;
  replies_24h: number;
  failed_24h: number;
  last_ok: string | null;
  last_error_at: string | null;
};

export type Check = { kind: string; ok: boolean; detail: string | null; created_at: string; last_ok_at: string | null };

export type SystemHealth = {
  families: number;
  people: number;
  database_bytes: number | string;
  replies_24h: number;
  failed_24h: number;
  open_holds: number;
  last_backup_at: string | null;
  last_backup_bytes: number | string | null;
  last_backup_restore_verified: boolean | null;
};

const NAMES: Record<string, string> = PROVIDER_NAME;
const HOUR = 3_600_000;
/** Supabase's free plan allows a 500 MB database. */
export const FREE_DB_BYTES = 500_000_000;

export function healthAlerts({
  dbOk,
  people,
  providers,
  checks,
  system,
  now = Date.now(),
}: {
  dbOk: boolean;
  people: { name: string; spent: number; cap: number }[];
  providers: FamilyProvider[];
  checks: Check[];
  system: SystemHealth | null;
  now?: number;
}): string[] {
  const alerts: string[] = [];
  if (!dbOk) alerts.push("The database isn't answering. Supabase may have paused the project.");

  const backup = checks.find((c) => c.kind === "backup");
  const lastGood = backup?.last_ok_at ? new Date(backup.last_ok_at).getTime() : 0;
  if (!lastGood || now - lastGood > 36 * HOUR) alerts.push("No good backup in the last 36 hours.");
  else if (backup && !backup.ok) alerts.push("The latest backup failed. The one before it is still kept.");
  const restore = checks.find((c) => c.kind === "restore_test");
  if (restore && !restore.ok) alerts.push("The latest restore test failed, so the newest backup may not be usable.");
  const keepAlive = checks.find((c) => c.kind === "keep_alive");
  if (keepAlive && !keepAlive.ok) alerts.push("The daily keep-alive couldn't reach Depeche.");

  for (const p of providers) {
    const name = NAMES[p.provider] ?? p.provider;
    if (p.failed_24h >= 3 && p.failed_24h * 2 >= p.replies_24h) {
      alerts.push(`${name} failed ${p.failed_24h} of ${p.replies_24h} replies in the last 24 hours. Its key, billing or limit may need a look.`);
    }
    if (p.models && p.models.length === 0) alerts.push(`${name}'s key can't use any of Depeche's models.`);
  }

  for (const p of people) {
    if (p.cap > 0 && p.spent >= p.cap) alerts.push(`${p.name} has reached their monthly limit.`);
    else if (p.cap > 0 && p.spent >= p.cap * 0.8) alerts.push(`${p.name} has used over 80% of their monthly limit.`);
  }

  if (system && Number(system.database_bytes) > FREE_DB_BYTES * 0.8) {
    alerts.push("The database is over 80% of Supabase's free 500 MB.");
  }
  return alerts;
}
