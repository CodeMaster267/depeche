import type { Metadata } from "next";
import Link from "next/link";
import { AppHeader, Page, Section } from "@/components/AppHeader";
import { requireMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { ShareRow } from "./forms";

export const metadata: Metadata = { title: "My gadgets · Depeche" };

type GadgetRow = { id: string; title: string; updated_at: string; shared_by: string | null };
type ShareRowData = { id: string; from_id: string; to_id: string | null; title: string; taken: boolean; created_at: string };

const IDEAS = [
  "Make me a chess gadget where I play against an AI I choose.",
  "A flashcards gadget to learn Spanish words, that remembers my progress.",
  "A tip and bill-splitting calculator.",
  "A quiz master that asks me general knowledge questions.",
];

/** My gadgets: the gadgets a person saved, ones shared with them, and the family shelf. */
export default async function MyGadgets() {
  const me = await requireMe();
  const db = await supabaseServer();
  const [{ data: gadgets }, { data: shares }, { data: people }] = await Promise.all([
    db.from("gadgets").select("id, title, updated_at, shared_by").eq("owner_id", me.userId).order("updated_at", { ascending: false }).returns<GadgetRow[]>(),
    db.from("gadget_shares").select("id, from_id, to_id, title, taken, created_at").order("created_at", { ascending: false }).limit(100).returns<ShareRowData[]>(),
    db.from("profiles").select("id, display_name").returns<{ id: string; display_name: string }[]>(),
  ]);
  const names = new Map((people ?? []).map((p) => [p.id, p.display_name]));
  const forMe = (shares ?? []).filter((s) => s.to_id === me.userId && !s.taken);
  const shelf = (shares ?? []).filter((s) => s.to_id === null);
  const isAdmin = me.profile.role === "admin";

  return (
    <>
      <AppHeader isAdmin={isAdmin} />
      <Page>
        <div className="flex flex-col gap-2">
          <h1 className="text-[28px] font-semibold tracking-tight">My gadgets</h1>
          <p className="text-[15px] text-mute">
            Little apps you asked a chat to make: games, calculators, quizzes. Ask in any chat, then tap Save to My gadgets. Gadgets that ask an AI show what each
            question cost, and it counts toward your spending.
          </p>
        </div>

        <Section title="Saved">
          {gadgets?.length ? (
            <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line" data-testid="my-gadgets">
              {gadgets.map((g) => (
                <li key={g.id}>
                  <Link href={`/gadgets/${g.id}`} className="press flex items-center justify-between gap-3 px-4 py-3">
                    <span className="min-w-0">
                      <span className="block truncate text-[17px]">{g.title}</span>
                      {g.shared_by ? <span className="block text-[13px] text-mute">From {names.get(g.shared_by) ?? "someone"}</span> : null}
                    </span>
                    <span aria-hidden className="text-mute">›</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-[15px] text-mute">No gadgets yet. Try asking a chat for one of these:</p>
              <ul className="flex flex-col gap-1.5 text-[15px]">
                {IDEAS.map((i) => (
                  <li key={i}>“{i}”</li>
                ))}
              </ul>
              <Link href="/" className="press self-start underline underline-offset-4">
                Open a chat
              </Link>
            </div>
          )}
        </Section>

        {forMe.length ? (
          <Section title="Shared with you">
            <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line" data-testid="shared-with-me">
              {forMe.map((s) => (
                <ShareRow key={s.id} id={s.id} title={s.title} from={names.get(s.from_id) ?? "Someone"} canRemove label="Not for me" />
              ))}
            </ul>
          </Section>
        ) : null}

        <Section title="Family shelf">
          {shelf.length ? (
            <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line" data-testid="family-shelf">
              {shelf.map((s) => (
                <ShareRow
                  key={s.id}
                  id={s.id}
                  title={s.title}
                  from={s.from_id === me.userId ? "You" : (names.get(s.from_id) ?? "Someone")}
                  mine={s.from_id === me.userId}
                  canRemove={s.from_id === me.userId || isAdmin}
                  label="Take off the shelf"
                />
              ))}
            </ul>
          ) : (
            <p className="text-[15px] text-mute">Nothing on the shelf yet. Share a gadget with the whole family from its page, and anyone can add a copy.</p>
          )}
        </Section>
      </Page>
    </>
  );
}
