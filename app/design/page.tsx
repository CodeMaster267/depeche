import type { Metadata } from "next";
import Link from "next/link";
import { AppHeader, Page, Section } from "@/components/AppHeader";
import { Notice } from "@/components/ui";
import { requireMe } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";
import { when } from "@/lib/family/log";
import { buildMeter, loadLook, resetDay, type DesignRow } from "@/lib/design/load";
import { cleanSpec } from "@/lib/design/spec";
import { BriefForm, HistoryButtons, LightDarkChoice, ResetButton, SafeModeToggle } from "./forms";

export const metadata: Metadata = { title: "My look · Depeche" };

const IDEAS = [
  "Make it playful and colourful, like a sunny day, with rounded letters.",
  "Put the chats list on the right on my phone.",
  "Make Web search its own button next to the box I write in.",
  "Bigger, easier to read text with strong contrast.",
  "Dark green and gold, calm and classy, with a serif font.",
];

/**
 * My look: describe a new look and have it built, see the build meter, go back to any earlier look,
 * reset to standard Depeche, or turn on safe mode. A family admin can also design for a member here.
 */
export default async function MyLook({ searchParams }: { searchParams: Promise<{ for?: string; safe?: string }> }) {
  const me = await requireMe();
  const { for: forParam, safe: justSafe } = await searchParams;
  const db = await supabaseServer();

  // Designing for someone else: only their family admin.
  let forPerson: { id: string; name: string } | null = null;
  if (forParam && forParam !== me.userId && /^[0-9a-f-]{36}$/i.test(forParam)) {
    const { data: ok } = await supabaseAdmin().rpc("is_admin_of", { actor: me.userId, person: forParam });
    if (ok) {
      const { data } = await supabaseAdmin().from("profiles").select("display_name").eq("id", forParam).maybeSingle<{ display_name: string }>();
      if (data) forPerson = { id: forParam, name: data.display_name };
    }
  }

  const [look, meter, { data: history }] = await Promise.all([
    loadLook(me),
    buildMeter(me.userId),
    db
      .from("designs")
      .select("id, name, spec, status, made_by, created_at, kept_at")
      .eq("owner_id", me.userId)
      .order("created_at", { ascending: false })
      .limit(30)
      .returns<DesignRow[]>(),
  ]);
  const { data: people } = await db.from("profiles").select("id, display_name").returns<{ id: string; display_name: string }[]>();
  const names = new Map((people ?? []).map((p) => [p.id, p.display_name]));
  const left = Math.max(0, meter.allowed - meter.used);
  const share = meter.allowed ? Math.min(1, meter.used / meter.allowed) : 1;

  return (
    <>
      <AppHeader isAdmin={me.profile.role === "admin"} />
      <Page>
        <div className="flex flex-col gap-1 pt-4">
          <h1 className="text-[34px] font-semibold tracking-tight">{forPerson ? `A look for ${forPerson.name}` : "My look"}</h1>
          <p className="text-[15px] text-mute">
            {forPerson
              ? `Describe how ${forPerson.name}'s Depeche should look. You'll see a preview, and ${forPerson.name} gets Keep or Undo the next time they open Depeche. It uses one of your builds.`
              : "Redesign your own Depeche: colours, fonts, text size, where things go, and buttons for the things you use most. Only you see it."}
          </p>
        </div>

        {!look.enabled ? <Notice>Your family admin has turned off redesigns for now, so everyone sees standard Depeche.</Notice> : null}
        {justSafe && look.safe ? <Notice>Safe mode is on: this device shows standard Depeche. Turn it off below when you&apos;re ready.</Notice> : null}

        <Section title={forPerson ? `Describe ${forPerson.name}'s look` : "Ask for a new look"}>
          <div className="flex flex-col gap-2" data-testid="build-meter">
            <div className="h-1.5 overflow-hidden rounded-full bg-line">
              <div className="h-full bg-fg" style={{ width: `${share * 100}%` }} />
            </div>
            <p className="text-[14px] text-mute">
              {meter.used} of {meter.allowed} design builds used this month · {left} left · resets {resetDay()}. Failed builds don&apos;t count.
            </p>
          </div>
          <BriefForm disabled={!look.enabled || left === 0} forId={forPerson?.id} forName={forPerson?.name} ideas={forPerson ? [] : IDEAS} />
          {!forPerson ? (
            <p className="text-[14px] text-mute">
              You can also just ask in any chat, like &ldquo;make my Depeche look like a beach&rdquo;. Depeche writes a short brief, and a
              bigger model builds it. Everything stays family friendly. Sign-in and the chat itself always work the same way.
            </p>
          ) : null}
        </Section>

        {!forPerson ? (
          <>
            <Section title="Now">
              <div className="flex flex-col gap-3 rounded-2xl border border-line p-4" data-testid="current-look">
                <p className="text-[17px] font-semibold">{look.current ? look.current.spec.name : "Standard Depeche"}</p>
                <p className="text-[15px] text-mute">{look.current ? look.current.spec.summary : "Black and white, as Depeche comes."}</p>
                {look.current ? <ResetButton /> : null}
              </div>
              <LightDarkChoice />
            </Section>

            <Section title="Earlier looks">
              {(history ?? []).length ? (
                <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line" data-testid="look-history">
                  {(history ?? []).map((d) => {
                    const inUse = look.current?.id === d.id;
                    const status = inUse
                      ? "In use"
                      : d.status === "kept"
                        ? "Kept before"
                        : d.status === "offered"
                          ? "Waiting for you"
                          : "Not kept";
                    const by = d.made_by && d.made_by !== me.userId ? ` · made by ${names.get(d.made_by) ?? "your admin"}` : "";
                    return (
                      <li key={d.id} className="flex flex-col gap-2 px-4 py-3">
                        <span className="flex items-baseline justify-between gap-3">
                          <span className="min-w-0 truncate text-[16px] font-medium">{d.name}</span>
                          <span className="shrink-0 text-[13px] text-mute">{status}</span>
                        </span>
                        <span className="text-[13px] text-mute">
                          {when(d.created_at)}
                          {by}
                        </span>
                        {!inUse ? <HistoryButtons id={d.id} spec={cleanSpec(d.spec)} /> : null}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-[15px] text-faint">Looks you try appear here, so you can go back to any of them for free.</p>
              )}
            </Section>

            <Section title="Safe mode">
              <p className="text-[15px] text-mute">
                If a look ever goes wrong, open <span className="font-mono text-fg">depai.vercel.app/safe</span> and this device shows standard
                Depeche until you turn safe mode off here.
              </p>
              <SafeModeToggle on={look.safe} />
            </Section>
          </>
        ) : (
          <Link href="/family/designs" className="text-[15px] underline underline-offset-4">
            Back to family designs
          </Link>
        )}
      </Page>
    </>
  );
}
