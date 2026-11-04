import type { Metadata } from "next";
import { AppHeader, Page, Section } from "@/components/AppHeader";
import { requireMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { Library, NewSkillForm, type LibraryItem } from "./forms";

export const metadata: Metadata = { title: "Skills · Depeche" };
export const dynamic = "force-dynamic";

const IDEAS = [
  "Help our family plan a monthly budget, track bills and save for holidays.",
  "Plan a wedding: guest lists, a timeline, vendors and a budget, including the nikah and walima.",
  "Help kids revise for GCSE maths by quizzing them one question at a time.",
  "Plan a week of halal dinners for four, with a shopping list.",
];

/**
 * Skills: make one by describing it, choose which library skills are yours, and browse everything
 * people across Depeche have made. Read with your own session, so the database decides what shows.
 */
export default async function Skills() {
  const me = await requireMe();
  const db = await supabaseServer();
  const [{ data: library }, { data: picks }, { data: removed }, { data: family }] = await Promise.all([
    db
      .from("skills")
      .select("id, name, description, owner_id, family_id, updated_at")
      .eq("status", "published")
      .order("updated_at", { ascending: false })
      .limit(500)
      .returns<{ id: string; name: string; description: string; owner_id: string; family_id: string; updated_at: string }[]>(),
    db.from("skill_picks").select("skill_id").eq("owner_id", me.userId).returns<{ skill_id: string }[]>(),
    db.from("skills").select("id, name, removed_note").eq("owner_id", me.userId).eq("status", "removed").returns<{ id: string; name: string; removed_note: string | null }[]>(),
    // Names only for your own family: people in other families stay anonymous.
    db.from("profiles").select("id, display_name").returns<{ id: string; display_name: string }[]>(),
  ]);
  const names = new Map((family ?? []).map((p) => [p.id, p.display_name.split(/\s+/)[0]]));
  const picked = new Set((picks ?? []).map((p) => p.skill_id));
  const items: LibraryItem[] = (library ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    by: s.owner_id === me.userId ? "You" : s.family_id === me.profile.family_id ? (names.get(s.owner_id) ?? "Your family") : "Another family",
    mine: picked.has(s.id),
  }));
  const mine = items.filter((s) => s.mine);

  return (
    <>
      <AppHeader isAdmin={me.profile.role === "admin"} />
      <Page>
        <div className="flex flex-col gap-2 pt-4">
          <h1 className="text-[34px] font-semibold tracking-tight">Skills</h1>
          <p className="text-[15px] text-mute">
            A skill teaches Depeche how to help with one kind of task, like a family budget or planning a wedding. Add a skill and your
            chats pick it up by themselves whenever a message is about it. Describe a new one and a model writes it and names it. Every
            skill is checked for safety and goes in the library for everyone on Depeche. Skills never see your memories or other chats.
          </p>
        </div>
        <Section title="Make a skill">
          <NewSkillForm ideas={IDEAS} />
        </Section>
        <Section title={mine.length ? `My skills (${mine.length})` : "My skills"}>
          {mine.length ? (
            <Library items={mine} testId="my-skills" />
          ) : (
            <p className="text-[15px] text-mute">None yet. Make one above, or add one from the library below.</p>
          )}
          {(removed ?? []).length ? (
            <ul className="flex flex-col gap-2 text-[15px] text-mute" data-testid="removed-skills">
              {(removed ?? []).map((s) => (
                <li key={s.id}>
                  <a href={`/skills/${s.id}`} className="underline underline-offset-4">{s.name}</a> was removed from the library by an admin
                  {s.removed_note ? `: ${s.removed_note}` : "."}
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
        <Section title={`Library (${items.length})`}>
          {items.length ? <Library items={items} search testId="library" /> : <p className="text-[15px] text-mute">The library is empty. Be the first to make a skill.</p>}
        </Section>
      </Page>
    </>
  );
}
