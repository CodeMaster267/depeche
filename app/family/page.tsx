import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppHeader, Page, Section } from "@/components/AppHeader";
import { requireMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { PROVIDERS } from "@/lib/ai/models";
import { CreateFamilyForm, InviteForm, MemberRow, ProviderKeyRow, RevokeButton } from "./forms";

export const metadata: Metadata = { title: "Family · Depeche" };

type Member = { id: string; display_name: string; username: string | null; role: string; monthly_cap_usd: string };
type Invite = { id: string; family_id: string; email: string; role: string; expires_at: string; accepted_at: string | null };

/**
 * The family admin's page. Everything here is read with the admin's own session, so row-level
 * security decides what shows: their members, spending and invites, and for the owner, only the
 * names of families they created.
 */
export default async function Family() {
  const me = await requireMe();
  if (me.profile.role !== "admin") redirect("/");
  const supabase = await supabaseServer();

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [{ data: family }, { data: members }, { data: invites }, { data: usage }, { data: families }, { data: keys }] = await Promise.all([
    supabase.from("families").select("name").eq("id", me.profile.family_id).single<{ name: string }>(),
    supabase
      .from("profiles")
      .select("id, display_name, username, role, monthly_cap_usd")
      .eq("family_id", me.profile.family_id)
      .order("created_at")
      .returns<Member[]>(),
    supabase
      .from("invites")
      .select("id, family_id, email, role, expires_at, accepted_at")
      .is("accepted_at", null)
      .order("created_at", { ascending: false })
      .returns<Invite[]>(),
    supabase.from("usage_events").select("owner_id, cost_usd").gte("created_at", monthStart.toISOString()),
    me.profile.is_app_owner
      ? supabase.from("families").select("id, name").neq("id", me.profile.family_id).order("created_at")
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    supabase
      .from("provider_keys")
      .select("provider, last4, updated_at")
      .eq("family_id", me.profile.family_id)
      .returns<{ provider: string; last4: string; updated_at: string }[]>(),
  ]);

  const spent = new Map<string, number>();
  for (const u of usage ?? []) spent.set(u.owner_id, (spent.get(u.owner_id) ?? 0) + Number(u.cost_usd));
  const pending = (invites ?? []).filter((i) => new Date(i.expires_at) > new Date());
  const mine = pending.filter((i) => i.family_id === me.profile.family_id);

  return (
    <>
      <AppHeader isAdmin />
      <Page>
        <div className="flex flex-col gap-1 pt-4">
          <h1 className="text-[34px] font-semibold tracking-tight">{family?.name ?? "Family"}</h1>
          <p className="text-[15px] text-mute">
            You can see members&apos; chat titles and spending, never what they write.
          </p>
        </div>

        <Section title="AI providers">
          <p className="text-[15px] text-mute">
            Everyone in your family chats using these keys. Keys are encrypted and never shown again.
          </p>
          <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line">
            {PROVIDERS.map((p) => (
              <ProviderKeyRow
                key={p.id}
                provider={p.id}
                name={p.name}
                keyUrl={p.keyUrl}
                hint={p.keyHint}
                saved={(keys ?? []).find((k) => k.provider === p.id)}
              />
            ))}
          </ul>
        </Section>

        <Section title="Members">
          <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line">
            {(members ?? []).map((m) => (
              <MemberRow
                key={m.id}
                member={m}
                spent={spent.get(m.id) ?? 0}
                isMe={m.id === me.userId}
              />
            ))}
          </ul>
        </Section>

        <Section title="Invite someone">
          <InviteForm />
          {mine.length ? (
            <ul className="flex flex-col gap-2">
              {mine.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-3 text-[15px]">
                  <span className="min-w-0 truncate text-mute">
                    {i.email} · waiting, expires {new Date(i.expires_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                  </span>
                  <RevokeButton id={i.id} />
                </li>
              ))}
            </ul>
          ) : null}
        </Section>

        {me.profile.is_app_owner ? (
          <Section title="Other families">
            <p className="text-[15px] text-mute">
              As the owner you can start a family and invite its admin. After that you see only its name.
            </p>
            {(families ?? []).length ? (
              <ul className="flex flex-col gap-2 text-[15px]">
                {(families ?? []).map((f) => {
                  const waiting = pending.find((i) => i.family_id === f.id);
                  return (
                    <li key={f.id} className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate">
                        {f.name}
                        {waiting ? <span className="text-mute"> · admin invite to {waiting.email} waiting</span> : null}
                      </span>
                      {waiting ? <RevokeButton id={waiting.id} /> : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <CreateFamilyForm />
          </Section>
        ) : null}
      </Page>
    </>
  );
}
