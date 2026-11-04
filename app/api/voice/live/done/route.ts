import { NextResponse, type NextRequest } from "next/server";
import { getMe } from "@/lib/auth/session";
import { decryptSecret } from "@/lib/crypto";
import { VOICE, liveSeconds } from "@/lib/voice/speech";
import { fail, recordUsage, reserveVoice } from "@/lib/voice/server";

/**
 * The browser says how long a live listening session ran, and its cost is recorded against the
 * person's monthly limit. Only the person the ticket was made for can report it, and never for
 * more time than had passed since the pass was handed out.
 */
export async function POST(req: NextRequest) {
  const me = await getMe();
  if (!me) return fail(401, "Sign in again to keep chatting.");
  const body = (await req.json().catch(() => ({}))) as { ticket?: unknown; seconds?: unknown };
  let minted = 0;
  try {
    const t = JSON.parse(decryptSecret(Buffer.from(String(body.ticket ?? ""), "base64url"))) as { u?: string; t?: number };
    if (t.u !== me.userId || typeof t.t !== "number") throw new Error("not theirs");
    minted = t.t;
  } catch {
    return fail(400, "Unknown session.");
  }
  const elapsed = (Date.now() - minted) / 1000;
  if (elapsed > VOICE.live.maxSeconds + 3600) return fail(400, "That session is too old.");
  const seconds = Math.min(liveSeconds(body.seconds), Math.max(1, Math.ceil(elapsed)));
  const cost = (seconds / 60) * VOICE.live.perMinute;
  // Recorded through a hold like everything else, so it counts the same way.
  const hold = await reserveVoice(me, { want: cost, need: 0 });
  if (hold instanceof NextResponse) return hold;
  // Audio is counted at 25 tokens a second, as Google does.
  await recordUsage(hold, "google", VOICE.live.model, seconds * 25, 0, cost);
  return NextResponse.json({ ok: true });
}
