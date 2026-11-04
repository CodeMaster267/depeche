import { NextResponse, type NextRequest } from "next/server";
import { getMe } from "@/lib/auth/session";
import { runSkillJob } from "@/lib/skills/service";
import { MAX_BRIEF } from "@/lib/skills/skill";

// Writing a skill takes a model up to a minute or so. Vercel Hobby allows up to 300 seconds.
export const maxDuration = 300;

/**
 * Makes a skill from what the person describes: {brief}. A model writes it and names it, it's
 * checked, then saved to the library and added to the person's own skills. Returns {skill}.
 */
export async function POST(req: NextRequest) {
  const me = await getMe();
  if (!me) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  if (me.profile.must_change_password) return NextResponse.json({ error: "Choose a new password first, in Account." }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { brief?: unknown };
  const brief = typeof body.brief === "string" ? body.brief.trim().slice(0, MAX_BRIEF) : "";
  if (brief.length < 8) return NextResponse.json({ error: "Describe the skill you'd like in a sentence or two." }, { status: 400 });
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort());
  const result = await runSkillJob(me, { kind: "create", brief }, abort.signal);
  if (!result.ok) return NextResponse.json({ error: result.error, refused: result.refused }, { status: result.status });
  return NextResponse.json({ skill: result.skill, cost: result.cost, model: result.model });
}
