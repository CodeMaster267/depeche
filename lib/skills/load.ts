import "server-only";
import type { supabaseServer } from "@/lib/supabase/server";
import type { MessageRow } from "@/lib/chat/thread";
import type { UsableSkill } from "./match";
import type { SkillFile } from "./skill";

type Db = Awaited<ReturnType<typeof supabaseServer>>;

/**
 * The skills a person has added, read with their own session: row-level security means only
 * their own list, and only skills still in the library (or their own).
 */
export async function mySkills(db: Db, ownerId: string): Promise<UsableSkill[]> {
  const { data } = await db
    .from("skill_picks")
    .select("skill:skills(id, name, description, instructions, files, triggers, status)")
    .eq("owner_id", ownerId)
    .limit(60)
    .returns<{ skill: (UsableSkill & { status: string; files: SkillFile[] }) | null }[]>();
  return (data ?? [])
    .map((r) => r.skill)
    .filter((s): s is UsableSkill & { status: string } => !!s && s.status === "published")
    .map(({ status: _status, ...s }) => ({ ...s, files: Array.isArray(s.files) ? s.files : [], triggers: s.triggers ?? [] }));
}

/** Skill ids used by the newest replies in a chat (the conversation shown), newest first. */
export function skillsUsedEarlier(path: readonly MessageRow[]): string[] {
  const ids: string[] = [];
  for (const m of [...path].reverse().slice(0, 8)) {
    for (const s of m.content.skills ?? []) if (!ids.includes(s.id)) ids.push(s.id);
  }
  return ids;
}
