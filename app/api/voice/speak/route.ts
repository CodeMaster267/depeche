import { NextResponse, type NextRequest } from "next/server";
import { MAX_SPEAK_CHARS, speak } from "@/lib/voice/speech";
import { speakable } from "@/lib/voice/text";
import { fail, prepare, reason, recordUsage } from "@/lib/voice/server";

export const maxDuration = 60;

/**
 * Reads text aloud with the family's own key. Returns raw 16-bit mono PCM, with the sample rate in
 * the x-sample-rate header. If the provider can't, the browser falls back to its built-in voice.
 */
export async function POST(req: NextRequest) {
  const ready = await prepare("speak");
  if (ready instanceof NextResponse) return ready;
  const { me, provider, apiKey } = ready;

  const body = (await req.json().catch(() => ({}))) as { text?: unknown };
  const text = typeof body.text === "string" ? speakable(body.text).slice(0, MAX_SPEAK_CHARS) : "";
  if (!text) return fail(400, "Nothing to read.");

  try {
    const s = await speak(provider, apiKey, text, req.signal);
    await recordUsage(me, provider, s.model, s.input, s.output, s.cost);
    return new Response(new Blob([s.pcm as BlobPart]), {
      headers: { "content-type": "application/octet-stream", "x-sample-rate": String(s.rate), "cache-control": "no-store" },
    });
  } catch (e) {
    return fail(502, reason(e));
  }
}
