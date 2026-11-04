import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppHeader, Page, Section } from "@/components/AppHeader";
import { requireMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { when } from "@/lib/family/log";
import { askableModels, familyKeys } from "@/lib/gadgets/server";
import { GadgetView } from "./view";
import { ChangeForm, GadgetSettings, ModelChoice, ShareForm, VersionButton } from "../forms";

export const metadata: Metadata = { title: "Gadget · Depeche" };

type Gadget = { id: string; title: string; html: string; model: string | null; shared_by: string | null; chat_id: string | null; updated_at: string };

/** One saved gadget, full width: use it, change it by asking, pick its AI, share a copy, go back a version. */
export default async function GadgetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const me = await requireMe();
  const db = await supabaseServer();
  // Row-level security: only the owner gets the row.
  const { data: g } = await db.from("gadgets").select("id, title, html, model, shared_by, chat_id, updated_at").eq("id", id).maybeSingle<Gadget>();
  if (!g) notFound();
  const [{ data: versions }, { data: people }, { keys }] = await Promise.all([
    db.from("gadget_versions").select("id, note, created_at").eq("gadget_id", g.id).order("created_at", { ascending: false }).limit(20).returns<{ id: string; note: string; created_at: string }[]>(),
    db.from("profiles").select("id, display_name").eq("family_id", me.profile.family_id).neq("id", me.userId).returns<{ id: string; display_name: string }[]>(),
    familyKeys(me.profile.family_id),
  ]);
  const models = askableModels(keys).map((m) => ({ id: m.id, name: m.name }));

  return (
    <>
      <AppHeader isAdmin={me.profile.role === "admin"} />
      <Page>
        <div className="flex flex-col gap-1">
          <Link href="/gadgets" className="press text-[14px] text-mute underline underline-offset-4">
            ‹ My gadgets
          </Link>
          <h1 className="text-[28px] font-semibold tracking-tight" data-testid="gadget-title">{g.title}</h1>
        </div>
        <GadgetView id={g.id} title={g.title} html={g.html} />

        <Section title="Change it">
          <ChangeForm id={g.id} />
        </Section>
        <Section title="Settings">
          <ModelChoice id={g.id} model={g.model} models={models} />
          <GadgetSettings id={g.id} title={g.title} />
        </Section>
        <Section title="Share">
          <p className="text-[15px] text-mute">They get their own copy. What this gadget remembers stays yours.</p>
          <ShareForm id={g.id} people={(people ?? []).map((p) => ({ id: p.id, name: p.display_name }))} />
        </Section>
        <Section title="Earlier versions">
          <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line" data-testid="gadget-versions">
            {(versions ?? []).map((v, i) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <span className="min-w-0">
                  <span className="block truncate text-[15px]">{v.note || "A change"}</span>
                  <span className="block text-[13px] text-mute">{when(v.created_at)}</span>
                </span>
                {i === 0 ? <span className="text-[13px] text-mute">In use</span> : <VersionButton id={g.id} versionId={v.id} />}
              </li>
            ))}
          </ul>
        </Section>
      </Page>
    </>
  );
}
