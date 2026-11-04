import { NextResponse, type NextRequest } from "next/server";
import { encryptSecret } from "@/lib/crypto";
import { liveToken, requestLanguages } from "@/lib/voice/speech";
import { fail, prepare, reason, releaseHold, reserveVoice } from "@/lib/voice/server";

/**
 * Hands the browser a one-time pass for one live listening session (Gemini's live transcription),
 * so words show up as they're said and voice chat answers sooner. Needs a Google key; without one
 * the browser uses the usual record-then-write-out listening.
 *
 * Nothing is held open against the monthly limit while the session runs (a held amount would block
 * chat replies until it expired). Instead the person must have room left now, and the browser gets
 * a sealed ticket to report how long the session ran (/api/voice/live/done); the time charged is
 * never more than had passed since the pass was handed out.
 */
export async function POST(req: NextRequest) {
  const ready = await prepare("listen");
  if (ready instanceof NextResponse) return ready;
  const { me, keys } = ready;
  const google = keys.find((k) => k.provider === "google");
  if (!google) return NextResponse.json({ off: "Live listening needs a Google key." }, { status: 404 });

  // Room left this month? (The check holds a little, then lets go straight away.)
  const check = await reserveVoice(me);
  if (check instanceof NextResponse) return check;
  await releaseHold(check, "google");
  try {
    const pass = await liveToken(google.apiKey, requestLanguages(req));
    const ticket = encryptSecret(JSON.stringify({ u: me.userId, t: Date.now() })).toString("base64url");
    return NextResponse.json({ ...pass, ticket }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return fail(502, reason("google", e).message);
  }
}
