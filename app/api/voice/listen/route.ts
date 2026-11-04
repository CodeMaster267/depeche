import { NextResponse, type NextRequest } from "next/server";
import { MAX_AUDIO_BYTES, requestLanguages, transcribe, wavSeconds } from "@/lib/voice/speech";
import { fail, prepare, reason, recordUsage, releaseHold, reserveVoice } from "@/lib/voice/server";

export const maxDuration = 60;

const TOO_LONG = "That was too long to hear in one go. Keep it under two minutes.";

/**
 * Turns a recording (16 kHz mono WAV, made in the browser) into text, using the family's own key.
 * The audio goes straight to the provider and is never stored.
 */
export async function POST(req: NextRequest) {
  const ready = await prepare("listen");
  if (ready instanceof NextResponse) return ready;
  const { me, keys } = ready;

  if (Number(req.headers.get("content-length") ?? 0) > MAX_AUDIO_BYTES) return fail(413, TOO_LONG);
  const wav = new Uint8Array(await req.arrayBuffer());
  if (wav.length > MAX_AUDIO_BYTES) return fail(413, TOO_LONG);
  if (wav.length < 44 || String.fromCharCode(...wav.subarray(0, 4)) !== "RIFF") return fail(400, "That recording didn't come through. Try again.");
  if (wavSeconds(wav) < 0.3) return NextResponse.json({ text: "" });

  const languages = requestLanguages(req);

  const hold = await reserveVoice(me);
  if (hold instanceof NextResponse) return hold;
  // Best provider first; if it fails (a used-up free quota, say), the next one tries.
  let problem = "";
  for (const { provider, apiKey } of keys) {
    try {
      const t = await transcribe(provider, apiKey, wav, req.signal, languages);
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
