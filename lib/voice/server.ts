import "server-only";
import { NextResponse } from "next/server";
import { getMe, type Me } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { decryptSecret, fromBytea } from "@/lib/crypto";
import type { Provider } from "@/lib/ai/models";
import { voiceProviders } from "@/lib/voice/speech";
import { allow } from "@/lib/rate-limit";

export const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

type Ready = { me: Me; provider: Provider; apiKey: string };

/**
 * The checks every voice request goes through, the same as a chat message: signed in, under the
 * monthly limit, and the family has a key for a provider that can do this. Returns the decrypted
 * key, which never leaves the server.
 */
export async function prepare(kind: "listen" | "speak"): Promise<Ready | NextResponse> {
  const me = await getMe();
  if (!me) return fail(401, "Sign in again to keep chatting.");
  if (me.profile.must_change_password) return fail(403, "Choose a new password first, in Account.");
  if (!(await allow(["voicePerMinute", me.userId]))) return fail(429, "That's a lot of voice at once. Wait a minute and try again.");
  const admin = supabaseAdmin();
  const { data: rows } = await admin
    .from("provider_keys")
    .select("provider, ciphertext")
    .eq("family_id", me.profile.family_id)
    .returns<{ provider: Provider; ciphertext: string }[]>();
  const keys = rows ?? [];
  const provider = voiceProviders(keys.map((k) => k.provider))[kind];
  if (!provider) {
    return fail(
      400,
      kind === "listen"
        ? "Voice needs a Google or OpenAI key. Ask your family admin to add one in Family settings."
        : "Reading aloud needs a Google or OpenAI key.",
    );
  }

  try {
    const apiKey = decryptSecret(fromBytea(keys.find((k) => k.provider === provider)!.ciphertext));
    return { me, provider, apiKey };
  } catch {
    return fail(500, "Your family's key needs to be added again. Ask your family admin.");
  }
}

/**
 * The most one voice request can cost: two minutes of listening, or reading 4,000 characters
 * aloud, priced high. Reserved before the provider is called, like a chat reply, so voice can never
 * take someone past their monthly limit either.
 */
const VOICE_HOLD = { want: 0.1, need: 0.01 };

/** Reserves the worst case for one voice request. Returns the hold's id, or the refusal to send. */
export async function reserveVoice(me: Me): Promise<string | NextResponse> {
  const { data, error } = await supabaseAdmin().rpc("reserve_spend", {
    p_person: me.userId,
    p_want: VOICE_HOLD.want,
    p_need: VOICE_HOLD.need,
  });
  const hold = (data as { hold_id: string }[] | null)?.[0];
  if (!hold) return fail(402, error?.code === "P0001" ? `${error.message}.` : "Couldn't check your spending limit. Try again.");
  return hold.hold_id;
}

/** Voice costs count against the same monthly limit as chat: the hold is swapped for the real cost. */
export async function recordUsage(hold: string, provider: Provider, model: string, input: number, output: number, cost: number) {
  await supabaseAdmin().rpc("settle_spend", {
    p_hold: hold,
    p_message: null,
    p_provider: provider,
    p_model: model,
    p_input: Math.max(0, Math.round(input)),
    p_output: Math.max(0, Math.round(output)),
    p_cost: Number(Math.max(0, cost).toFixed(6)),
  });
}

/** Lets go of a hold when the provider was never charged. */
export async function releaseHold(hold: string, provider: Provider) {
  await recordUsage(hold, provider, "none", 0, 0, 0);
}

/** A short reason code for the browser. Logged for debugging; never includes the key. */
export function reason(e: unknown): "busy" | "key" | "failed" {
  const status = (e as { status?: unknown })?.status;
  const msg = e instanceof Error ? e.message : String(e ?? "");
  console.error("[voice]", typeof status === "number" ? status : "", msg.slice(0, 240));
  if (status === 429 || /quota|rate limit|resource.?exhausted/i.test(msg)) return "busy";
  if (status === 401 || status === 403 || /api key|permission/i.test(msg)) return "key";
  return "failed";
}
