import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppHeader, Page, Section } from "@/components/AppHeader";
import { requireMe } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";
import { when } from "@/lib/family/log";
import { findModel } from "@/lib/ai/models";
import { designsOffEverywhere } from "@/lib/design/load";
import { DesignSettingsForm, MemberBuildsForm } from "./forms";

export const metadata: Metadata = { title: "Family designs · Depeche" };

type Build = {
  id: string;
  owner_id: string;
  requested_by: string | null;
  brief: string;
  status: string;
  model: string | null;
  cost_usd: string;
  unmet: string[];
  note: string | null;
  created_at: string;
};

const STATUS: Record<string, string> = { built: "Built", building: "Building", failed: "Failed (not counted)", refused: "Turned down (not counted)" };

/**
 * The family admin's view of personal designs: the kill switch, how many builds each person gets,
 * a to-do list of requests designs couldn't do yet, and every build. Read with the admin's session,
 * so row-level security shows only their own family.
 */
export default async function FamilyDesigns() {
  const me = await requireMe();
  if (me.profile.role !== "admin") redirect("/design");
  const db = await supabaseServer();
  const admin = supabaseAdmin();

  const [{ data: settings }, { data: members }, { data: allowances }, { data: builds }] = await Promise.all([
    db.from("design_settings").select("enabled, builds_per_month").eq("family_id", me.profile.family_id).maybeSingle<{ enabled: boolean; builds_per_month: number }>(),
    db.from("profiles").select("id, display_name").eq("family_id", me.profile.family_id).order("created_at").returns<{ id: string; display_name: string }[]>(),
    db.from("design_allowances").select("person_id, builds_per_month").returns<{ person_id: string; builds_per_month: number }[]>(),
    db
      .from("design_builds")
      .select("id, owner_id, requested_by, brief, status, model, cost_usd, unmet, note, created_at")
      .eq("family_id", me.profile.family_id)
      .order("created_at", { ascending: false })
      .limit(100)
      .returns<Build[]>(),
  ]);
  const names = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  const own = new Map((allowances ?? []).map((a) => [a.person_id, a.builds_per_month]));
  const used = new Map<string, number>();
  await Promise.all(
    (members ?? []).map(async (m) => {
      const { data } = await admin.rpc("design_builds_used", { p_person: m.id });
      used.set(m.id, Number(data ?? 0));
    }),
  );
  const familyBuilds = settings?.builds_per_month ?? 10;
  const enabled = settings?.enabled ?? true;
  const todo = (builds ?? []).filter((b) => b.unmet.length || b.status === "refused");
  const name = (id: string | null) => (id ? (names.get(id) ?? "Someone") : "Someone");

  return (
    <>
      <AppHeader isAdmin />
      <Page>
        <div className="flex flex-col gap-1 pt-4">
          <Link href="/family" className="text-[14px] text-mute underline underline-offset-4">
            Family
          </Link>
          <h1 className="text-[34px] font-semibold tracking-tight">Designs</h1>
          <p className="text-[15px] text-mute">
            Everyone can redesign their own Depeche. Each build uses a bigger model on your family&apos;s keys, so it counts toward their
            spending and uses one of their builds for the month. Failed and turned-down builds don&apos;t count. You see requests and
            builds here, never anyone&apos;s chats.
          </p>
        </div>

        {designsOffEverywhere() ? <p className="text-[15px]">Designs are switched off for every family in Depeche&apos;s settings.</p> : null}

        <Section title="Switch and builds">
          <DesignSettingsForm enabled={enabled} builds={familyBuilds} />
        </Section>

        <Section title="People">
          <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line" data-testid="design-people">
            {(members ?? []).map((m) => (
              <li key={m.id} className="flex flex-col gap-3 px-4 py-3">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-[16px] font-medium">{m.display_name}</span>
                  <span className="shrink-0 text-[13px] text-mute">
                    {used.get(m.id) ?? 0} of {own.get(m.id) ?? familyBuilds} used
                  </span>
                </span>
                <MemberBuildsForm member={m.id} name={m.display_name} builds={own.get(m.id) ?? null} familyBuilds={familyBuilds} />
                {m.id !== me.userId ? (
                  <Link href={`/design?for=${m.id}`} className="self-start text-[14px] underline underline-offset-4">
                    Design a look for {m.display_name}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Couldn't do yet">
          <p className="text-[15px] text-mute">Parts of requests that designs can&apos;t do yet, and requests that were turned down. A to-do list for new abilities.</p>
          {todo.length ? (
            <ul className="flex flex-col gap-3 text-[15px]" data-testid="design-todo">
              {todo.map((b) => (
                <li key={b.id} className="flex flex-col">
                  <span>{b.status === "refused" ? `Turned down: ${b.note ?? "not family friendly"}` : b.unmet.join("; ")}</span>
                  <span className="text-[13px] text-mute">
                    {name(b.requested_by)} asked: &ldquo;{b.brief.slice(0, 160)}
                    {b.brief.length > 160 ? "…" : ""}&rdquo; · {when(b.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[15px] text-faint">Nothing yet.</p>
          )}
        </Section>

        <Section title="Activity">
          {(builds ?? []).length ? (
            <ul className="flex flex-col gap-3 text-[15px]" data-testid="design-activity">
              {(builds ?? []).map((b) => (
                <li key={b.id} className="flex flex-col">
                  <span>
                    {name(b.requested_by)}
                    {b.owner_id !== b.requested_by ? ` for ${name(b.owner_id)}` : ""}: {STATUS[b.status] ?? b.status}
                    {b.model ? ` · ${findModel(b.model)?.short ?? b.model}` : ""}
                    {Number(b.cost_usd) > 0 ? ` · $${Number(b.cost_usd).toFixed(2)}` : ""}
                  </span>
                  <span className="text-[13px] text-mute">
                    &ldquo;{b.brief.slice(0, 120)}
                    {b.brief.length > 120 ? "…" : ""}&rdquo; · {when(b.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[15px] text-faint">No builds yet.</p>
          )}
        </Section>
      </Page>
    </>
  );
}
