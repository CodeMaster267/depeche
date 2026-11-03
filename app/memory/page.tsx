import type { Metadata } from "next";
import { AppHeader, Page, Section } from "@/components/AppHeader";
import { requireMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { forgetMemory } from "./actions";
import { AddMemoryForm, ForgetAllButton } from "./forms";

export const metadata: Metadata = { title: "Memory · Depeche" };
export const dynamic = "force-dynamic";

/** What Depeche remembers about you. Read with your own session: nobody else can see it. */
export default async function Memory() {
  const me = await requireMe();
  const { data: memories } = await (await supabaseServer())
    .from("memories")
    .select("id, content, updated_at")
    .eq("owner_id", me.userId)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .returns<{ id: string; content: string; updated_at: string }[]>();
  const list = memories ?? [];

  return (
    <>
      <AppHeader isAdmin={me.profile.role === "admin"} />
      <Page>
        <div className="flex flex-col gap-2 pt-4">
          <h1 className="text-[34px] font-semibold tracking-tight">Memory</h1>
          <p className="text-[15px] text-mute">
            Things Depeche remembers about you, used in every chat. Only you can see them, not your family admin. Now and then a
            reply suggests something to remember, and it&apos;s only kept if you say so.
          </p>
        </div>
        <Section title={list.length ? `Remembered (${list.length})` : "Remembered"}>
          {list.length ? (
            <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line" data-testid="memories">
              {list.map((m) => (
                <li key={m.id} className="flex items-start justify-between gap-4 px-4 py-3.5">
                  <span className="text-[16px] leading-relaxed">{m.content}</span>
                  <form action={forgetMemory.bind(null, m.id)} className="shrink-0">
                    <button type="submit" className="text-[15px] text-mute underline underline-offset-4" aria-label={`Forget: ${m.content}`}>
                      Forget
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[15px] text-mute">Nothing yet.</p>
          )}
        </Section>
        <Section title="Teach Depeche">
          <AddMemoryForm />
        </Section>
        {list.length ? (
          <Section title="Start over">
            <ForgetAllButton />
          </Section>
        ) : null}
      </Page>
    </>
  );
}
