import { describe, expect, it } from "vitest";
import { healthAlerts } from "@/lib/health";

const now = Date.parse("2026-11-03T12:00:00Z");
const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();
const goodBackup = { kind: "backup", ok: true, detail: null, created_at: hoursAgo(5), last_ok_at: hoursAgo(5) };
const base = { dbOk: true, people: [], providers: [], checks: [goodBackup], system: null, now };

describe("health alerts", () => {
  it("are quiet when everything is fine", () => {
    expect(healthAlerts(base)).toEqual([]);
  });

  it("flag a missing, failed or unrestorable backup", () => {
    expect(healthAlerts({ ...base, checks: [] })).toEqual(["No good backup in the last 36 hours."]);
    expect(healthAlerts({ ...base, checks: [{ ...goodBackup, last_ok_at: hoursAgo(40) }] })[0]).toMatch(/36 hours/);
    expect(healthAlerts({ ...base, checks: [{ ...goodBackup, ok: false }] })[0]).toMatch(/latest backup failed/);
    const restore = { kind: "restore_test", ok: false, detail: null, created_at: hoursAgo(5), last_ok_at: null };
    expect(healthAlerts({ ...base, checks: [goodBackup, restore] })[0]).toMatch(/restore test failed/);
  });

  it("flag a provider failing most replies, but not the odd failure", () => {
    const p = { provider: "google", models: ["x"], checked_at: null, replies_24h: 10, failed_24h: 1, last_ok: null, last_error_at: null };
    expect(healthAlerts({ ...base, providers: [p] })).toEqual([]);
    expect(healthAlerts({ ...base, providers: [{ ...p, failed_24h: 6 }] })[0]).toMatch(/Google failed 6 of 10/);
  });

  it("flag people at or near their limit, and a filling database", () => {
    const alerts = healthAlerts({
      ...base,
      people: [
        { name: "Amir", spent: 10, cap: 10 },
        { name: "Mina", spent: 8.5, cap: 10 },
        { name: "Zain", spent: 1, cap: 10 },
      ],
      system: { families: 1, people: 3, database_bytes: 450_000_000, replies_24h: 0, failed_24h: 0, open_holds: 0, last_backup_at: null, last_backup_bytes: null, last_backup_restore_verified: null },
    });
    expect(alerts).toEqual([
      "Amir has reached their monthly limit.",
      "Mina has used over 80% of their monthly limit.",
      "The database is over 80% of Supabase's free 500 MB.",
    ]);
  });
});
