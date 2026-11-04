import type { Metadata } from "next";
import { AppHeader, Page, Section } from "@/components/AppHeader";
import { requireMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { forgetMemory } from "./actions";
import { AddMemoryForm, ForgetAllButton, InstructionsForm } from "./forms";
import type { PersonalInstructions } from "@/lib/chat/instructions";
import { aboutHeading } from "@/lib/chat/memory-check";

/** You first, then everyone else by name, then facts nobody is tied to yet. */
const rank = (heading: string) => (heading === "You" ? 0 : heading === "" ? 2 : 1);

export const metadata: Metadata = { title: "Memory · Depeche" };
export const dynamic = "force-dynamic";

/** What Depeche remembers about you. Read with your own session: nobody else can see it. */
export default async function Memory() {
  const me = await requireMe();
  const db = await supabaseServer();
  const { data: instructions } = await db
    .from("personal_instructions")
    .select("about_me, answer_style, enabled")
    .eq("owner_id", me.userId)
    .maybeSingle<PersonalInstructions>();
  const { data: memories } = await db
    .from("memories")
    .select("id, content, about, updated_at")
    .eq("owner_id", me.userId)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .returns<{ id: string; content: string; about: string | null; updated_at: string }[]>();
  const list = memories ?? [];
  // Grouped by who each fact is about, you first, so nobody's facts get mixed up with another's.
  const groups = new Map<string, typeof list>();
  for (const m of list) {
    const key = m.about ? aboutHeading(m.about) : "";
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  const order = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const headed = order.length > 1 || (order.length === 1 && order[0] !== "" && order[0] !== "You");

  return (
    <>
      <AppHeader isAdmin={me.profile.role === "admin"} />
      <Page>
        <div className="flex flex-col gap-2 pt-4">
          <h1 className="text-[34px] font-semibold tracking-tight">Memory</h1>
          <p className="text-[15px] text-mute">
            What Depeche knows about you and how you like your answers, used in every chat with every model. Only you can see
            this, not your family admin. Now and then a reply suggests something to remember, and it&apos;s only kept if you say so. Before anything is kept, Depeche checks it against what it already knows, and asks you when something doesn&apos;t fit.
          </p>
        </div>
        <Section title="Personal instructions">
          <InstructionsForm initial={instructions ?? { about_me: "", answer_style: "", enabled: true }} />
        </Section>
        <Section title={list.length ? `Remembered (${list.length})` : "Remembered"}>
          {list.length ? (
            <div className="flex flex-col gap-5" data-testid="memories">
              {order.map((key) => (
                <div key={key || "other"} className="flex flex-col gap-2" data-testid="memory-group">
                  {headed ? <h3 className="text-[13px] font-semibold uppercase tracking-[0.1em] text-mute">{key || "Other"}</h3> : null}
                  <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line">
                    {groups.get(key)!.map((m) => (
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
                </div>
              ))}
            </div>
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
