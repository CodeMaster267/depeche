import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { requestLanguages, transcribe, VOICE } from "@/lib/voice/speech";
import { fail, prepare, reason, recordUsage, releaseHold, reserveVoice } from "@/lib/voice/server";
import { AUDIO_TYPES, MAX_VOICE_NOTE_BYTES, VOICE_NOTE_BUCKET, chargeableSeconds, isVoiceNotePath } from "@/lib/voice/notes";

// Half an hour of audio can take a few minutes to write out.
export const maxDuration = 300;

/**
 * Writes out a voice note or other recording the person put in their own voice-notes folder, using
 * the family's key. The recording is deleted as soon as it has been read, whether or not that
 * worked, and only the text goes back.
 *
 * Body: { path, seconds } where `seconds` is the length the browser read from the file.
 */
export async function POST(req: NextRequest) {
  const ready = await prepare("listen");
  if (ready instanceof NextResponse) return ready;
  const { me, keys } = ready;

  const body = (await req.json().catch(() => null)) as { path?: unknown; seconds?: unknown } | null;
  const path = body?.path;
  if (!isVoiceNotePath(path, me.userId)) return fail(400, "That recording didn't come through. Try again.");

  const storage = supabaseAdmin().storage.from(VOICE_NOTE_BUCKET);
  const forget = () => storage.remove([path]).catch(() => {});
  const { data: blob, error } = await storage.download(path);
  if (error || !blob) return fail(404, "That recording didn't come through. Try again.");
  if (blob.size > MAX_VOICE_NOTE_BYTES) {
    await forget();
    return fail(413, "That recording is over 25 MB. Try a shorter one.");
  }
  const mime = blob.type.split(";")[0];
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await forget();
  if (!(mime in AUDIO_TYPES)) return fail(415, "Depeche can't read that kind of recording.");

  const seconds = chargeableSeconds(body?.seconds, bytes.length);
  const languages = requestLanguages(req);

  // Held up front, like a reply: the most this can cost on the dearest provider, priced high.
  const worst = Math.max(
    (seconds / 60) * VOICE.transcribe.openai.perMinute,
    (seconds * 32 * VOICE.transcribe.google.perMillionIn + 16_000 * VOICE.transcribe.google.perMillionOut) / 1_000_000,
  );
  const hold = await reserveVoice(me, { want: Math.max(0.02, worst * 1.5), need: Math.max(0.01, worst) });
  if (hold instanceof NextResponse) return hold;

  let problem = "";
  for (const { provider, apiKey } of keys) {
    try {
      const t = await transcribe(provider, apiKey, { bytes, mime, seconds }, req.signal, languages);
      await recordUsage(hold, provider, t.model, t.input, t.output, t.cost);
      return NextResponse.json({ text: t.text, by: provider });
    } catch (e) {
      if (req.signal.aborted) break;
      problem ||= reason(provider, e).message;
    }
  }
  await releaseHold(hold, keys[0].provider);
  return fail(502, problem || "Couldn't write out that recording. Try again.");
}
