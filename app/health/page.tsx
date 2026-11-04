import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppHeader, Page, Section } from "@/components/AppHeader";
import { requireMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { PROVIDERS } from "@/lib/ai/models";
import { healthAlerts, type Check, type FamilyProvider, type SystemHealth } from "@/lib/health";

export const metadata: Metadata = { title: "Health · Depeche" };
export const dynamic = "force-dynamic";

const day = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC"
    : "never";
const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * One compact screen: is Depeche working, are backups happening, how much of the family's budget is
 * left, and are the AI companies answering. Family admins see their own family; the owner also sees
 * the system as a whole (sizes and totals only, never another family's people or spending).
 */
export default async function Health() {
  const me = await requireMe();
  if (me.profile.role !== "admin") redirect("/");
  const db = await supabaseServer();
  const admin = supabaseAdmin();

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const started = Date.now();
  const [{ data: members, error: dbError }, { data: usage }, { data: providers }, { data: checks }, system] = await Promise.all([
    db
      .from("profiles")
      .select("id, display_name, monthly_cap_usd")
      .eq("family_id", me.profile.family_id)
      .returns<{ id: string; display_name: string; monthly_cap_usd: string }[]>(),
    db.from("usage_events").select("owner_id, cost_usd").gte("created_at", monthStart.toISOString()),
    admin.rpc("family_health", { p_actor: me.userId }),
    admin.rpc("latest_checks", { p_actor: me.userId }),
    me.profile.is_app_owner ? admin.rpc("system_health", { p_actor: me.userId }) : Promise.resolve({ data: null }),
  ]);
  const ms = Date.now() - started;

  const spent = new Map<string, number>();
  for (const u of usage ?? []) spent.set(u.owner_id, (spent.get(u.owner_id) ?? 0) + Number(u.cost_usd));
  const people = (members ?? []).map((m) => ({ name: m.display_name, spent: spent.get(m.id) ?? 0, cap: Number(m.monthly_cap_usd) }));
  const totalSpent = people.reduce((n, p) => n + p.spent, 0);
  const totalCap = people.reduce((n, p) => n + p.cap, 0);
  const keys = (providers as FamilyProvider[] | null) ?? [];
  const latest = (checks as Check[] | null) ?? [];
  const sys = ((system.data as SystemHealth[] | null) ?? [])[0] ?? null;
  const alerts = healthAlerts({ dbOk: !dbError, people, providers: keys, checks: latest, system: sys });
  const check = (kind: string) => latest.find((c) => c.kind === kind);

  return (
    <>
      <AppHeader isAdmin />
      <Page>
        <div className="flex flex-col gap-1 pt-4">
          <h1 className="text-[34px] font-semibold tracking-tight">Health</h1>
          <p className="text-[15px] text-mute">Checked {day(new Date().toISOString())}.</p>
        </div>

        <Section title={alerts.length ? "Needs attention" : "All good"}>
          {alerts.length ? (
            <ul className="flex flex-col gap-2" data-testid="alerts">
              {alerts.map((a) => (
                <li key={a} className="rounded-2xl border border-fg px-4 py-3 text-[15px]">
                  {a}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[15px] text-mute" data-testid="alerts">Nothing needs you right now.</p>
          )}
        </Section>

        <Section title="Database and sync">
          <Rows
            rows={[
              ["Connection", dbError ? "Not answering" : `Answering (${ms} ms)`],
              ["Last successful sync", dbError ? "unknown" : day(new Date().toISOString())],
              ["Keep-alive", check("keep_alive") ? `${check("keep_alive")!.ok ? "OK" : "Failed"} · ${day(check("keep_alive")!.created_at)}` : "not run yet"],
            ]}
          />
        </Section>

        <Section title="Backups">
          <Rows
            rows={[
              ["Last backup", check("backup") ? `${check("backup")!.ok ? "OK" : "Failed"} · ${day(check("backup")!.created_at)}` : "none yet"],
              ["Last good backup", day(check("backup")?.last_ok_at)],
              ["Restore test", check("restore_test") ? `${check("restore_test")!.ok ? "Passed" : "Failed"} · ${day(check("restore_test")!.created_at)}` : "not run yet"],
            ]}
          />
          <p className="text-[13px] text-mute">Encrypted copies are kept for 30 days, then deleted.</p>
        </Section>

        <Section title="Family spending this month">
          <p className="text-[17px] tabular-nums" data-testid="family-spend">
            {money(totalSpent)} <span className="text-mute">of {money(totalCap)} · {money(Math.max(0, totalCap - totalSpent))} left</span>
          </p>
          <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line">
            {people.map((p, i) => (
              <li key={i} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[15px]">
                <span className="min-w-0 truncate">{p.name}</span>
                <span className="shrink-0 tabular-nums">
                  {money(p.spent)} <span className="text-mute">· {money(Math.max(0, p.cap - p.spent))} left</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="text-[13px] text-mute">Estimates from token counts. Each AI company&apos;s own bill is the final word.</p>
        </Section>

        <Section title="AI providers">
          {keys.length ? (
            <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line" data-testid="providers">
              {keys.map((k) => {
                const name = PROVIDERS.find((p) => p.id === k.provider)?.name ?? k.provider;
                return (
                  <li key={k.provider} className="flex flex-col gap-0.5 px-4 py-3">
                    <span className="text-[17px]">{name}</span>
                    <span className="text-[13px] text-mute">
                      Last 24 hours: {k.replies_24h} {k.replies_24h === 1 ? "reply" : "replies"}, {k.failed_24h} failed · last good reply {day(k.last_ok)}
                    </span>
                    <span className="text-[13px] text-mute">
                      {k.models ? `${k.models.length} models usable with this key` : "Models not checked yet"} · checked {day(k.checked_at)}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-[15px] text-mute">No AI keys yet. Add one on the Family page.</p>
          )}
        </Section>

        {sys ? (
          <Section title="System (only you see this)">
            <Rows
              rows={[
                ["Families", String(sys.families)],
                ["People", String(sys.people)],
                ["Database size", `${(Number(sys.database_bytes) / 1e6).toFixed(0)} MB of 500 MB free`],
                ["Replies in 24 hours", `${sys.replies_24h}, ${sys.failed_24h} failed`],
                ["Replies running now", String(sys.open_holds)],
                [
                  "Last verified backup",
                  sys.last_backup_at
                    ? `${day(sys.last_backup_at)} · ${(Number(sys.last_backup_bytes ?? 0) / 1e6).toFixed(1)} MB · restore ${sys.last_backup_restore_verified ? "verified" : "not verified"}`
                    : "none yet",
                ],
                ["Deployed version", (process.env.VERCEL_GIT_COMMIT_SHA ?? "local").slice(0, 7)],
              ]}
            />
            <p className="text-[13px] text-mute">Problems also open a GitHub issue, which GitHub emails to you.</p>
          </Section>
        ) : null}
      </Page>
    </>
  );
}

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="flex flex-col divide-y divide-line rounded-2xl border border-line">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[15px]">
          <dt className="text-mute">{k}</dt>
          <dd className="min-w-0 truncate text-right tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
