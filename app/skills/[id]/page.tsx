import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppHeader, Page, Section } from "@/components/AppHeader";
import { Notice } from "@/components/ui";
import { Markdown } from "@/components/markdown/Markdown";
import { requireMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { findModel } from "@/lib/ai/models";
import type { Skill } from "@/lib/skills/skill";
import { DeleteSkillButton, PickButton, RemoveFromLibraryForm, SkillEditor } from "../forms";

export const metadata: Metadata = { title: "Skill · Depeche" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One skill: what it says, Add or Remove, and for its maker, changing or deleting it. */
export default async function SkillPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ made?: string }> }) {
  const me = await requireMe();
  const { id } = await params;
  const { made } = await searchParams;
  if (!UUID.test(id)) notFound();
  const db = await supabaseServer();
  // Row-level security: a library skill, or one of your own.
  const { data: skill } = await db.from("skills").select("*").eq("id", id).maybeSingle<Skill>();
  if (!skill) notFound();
  const [{ data: pick }, { data: maker }] = await Promise.all([
    db.from("skill_picks").select("skill_id").eq("owner_id", me.userId).eq("skill_id", id).maybeSingle(),
    db.from("profiles").select("display_name").eq("id", skill.owner_id).maybeSingle<{ display_name: string }>(),
  ]);
  const mineToEdit = skill.owner_id === me.userId;
  const by = mineToEdit ? "you" : maker ? maker.display_name.split(/\s+/)[0] : "someone in another family";
  const canRemove = skill.status === "published" && (me.profile.is_app_owner || (me.profile.role === "admin" && skill.family_id === me.profile.family_id));
  const writer = findModel(skill.model)?.name;
  const files = Array.isArray(skill.files) ? skill.files : [];

  return (
    <>
      <AppHeader isAdmin={me.profile.role === "admin"} />
      <Page>
        <div className="flex flex-col gap-3 pt-4">
          <Link href="/skills" className="text-[15px] text-mute underline underline-offset-4">All skills</Link>
          <h1 className="break-words font-mono text-[28px] font-semibold tracking-tight" data-testid="skill-name">{skill.name}</h1>
          <p className="text-[17px] leading-relaxed" data-testid="skill-description">{skill.description}</p>
          <p className="text-[14px] text-mute">
            Made by {by}
            {writer ? `, written by ${writer}` : ""}
            {skill.version > 1 ? ` · version ${skill.version}` : ""}
          </p>
          {made ? <Notice>Your skill is ready and in the library. It&apos;s on your list, so your chats will use it when it fits.</Notice> : null}
          {skill.status === "removed" ? (
            <Notice tone="error">
              An admin removed this skill from the library{skill.removed_note ? `: ${skill.removed_note}` : "."} Nobody&apos;s chats use it now. You can still delete it.
            </Notice>
          ) : (
            <PickButton id={skill.id} mine={!!pick} name={skill.name} big />
          )}
        </div>

        <Section title="Instructions">
          <div className="rounded-2xl border border-line px-4 py-3" data-testid="skill-instructions">
            <Markdown text={skill.instructions} />
          </div>
        </Section>

        {files.length ? (
          <Section title={`Files (${files.length})`}>
            <div className="flex flex-col gap-2">
              {files.map((f) => (
                <details key={f.name} className="rounded-2xl border border-line px-4 py-3">
                  <summary className="cursor-pointer font-mono text-[15px]">{f.name}</summary>
                  <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-[14px] text-mute">{f.content}</pre>
                </details>
              ))}
            </div>
          </Section>
        ) : null}

        {skill.triggers?.length ? (
          <Section title="Picked up when a message mentions">
            <p className="flex flex-wrap gap-2" data-testid="skill-triggers">
              {skill.triggers.map((t) => (
                <span key={t} className="rounded-full border border-line px-3 py-1 text-[14px] text-mute">{t}</span>
              ))}
            </p>
            <p className="text-[13px] text-mute">Or when a message names it: {skill.name}.</p>
          </Section>
        ) : null}

        {mineToEdit && skill.status === "published" ? (
          <Section title="Change this skill">
            <SkillEditor skill={{ id: skill.id, description: skill.description, instructions: skill.instructions, files, triggers: skill.triggers ?? [] }} />
          </Section>
        ) : null}
        {mineToEdit ? (
          <Section title="Delete">
            <p className="text-[15px] text-mute">Deleting takes it out of the library and off everyone&apos;s list.</p>
            <DeleteSkillButton id={skill.id} />
          </Section>
        ) : null}
        {canRemove && !mineToEdit ? (
          <Section title="Admin">
            <RemoveFromLibraryForm id={skill.id} />
          </Section>
        ) : null}
      </Page>
    </>
  );
}
