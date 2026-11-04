import "server-only";
import { NextResponse } from "next/server";
import { getMe, type Me } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { decryptSecret, fromBytea } from "@/lib/crypto";
import { PROVIDER_NAME, type Provider } from "@/lib/ai/models";
import { voiceProviders } from "@/lib/voice/speech";
import { allow } from "@/lib/rate-limit";

export const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

type Ready = { me: Me; keys: { provider: Provider; apiKey: string }[] };

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
  const order = voiceProviders(keys.map((k) => k.provider))[kind];
  if (!order.length) {
    return fail(
      400,
      kind === "listen"
        ? "Voice needs a Google or OpenAI key. Ask your family admin to add one in Family settings."
        : "Reading aloud needs a Google or OpenAI key.",
    );
  }
  const usable: Ready["keys"] = [];
  for (const provider of order) {
    try {
      usable.push({ provider, apiKey: decryptSecret(fromBytea(keys.find((k) => k.provider === provider)!.ciphertext)) });
    } catch {
      // That key needs adding again; the others may still work.
    }
  }
  if (!usable.length) return fail(500, "Your family's key needs to be added again. Ask your family admin.");
  return { me, keys: usable };
}

/**
 * The most one voice request can cost: two minutes of listening, or reading 4,000 characters
 * aloud, priced high. Reserved before the provider is called, like a chat reply, so voice can never
 * take someone past their monthly limit either.
 */
const VOICE_HOLD = { want: 0.1, need: 0.01 };

/** Reserves the worst case for one voice request. Returns the hold's id, or the refusal to send. */
export async function reserveVoice(me: Me, amount = VOICE_HOLD): Promise<string | NextResponse> {
  const { data, error } = await supabaseAdmin().rpc("reserve_spend", {
    p_person: me.userId,
    p_want: amount.want,
    p_need: amount.need,
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

/** The provider's own words, unwrapped from the JSON some SDKs nest them in. Never includes the key. */
function detail(e: unknown): string {
  let msg = e instanceof Error ? e.message : String(e ?? "");
  for (let i = 0; i < 3; i++) {
    try {
      const parsed = JSON.parse(msg.slice(msg.indexOf("{"))) as { error?: { message?: string }; message?: string };
      const inner = parsed.error?.message ?? parsed.message;
      if (typeof inner !== "string" || inner === msg) break;
      msg = inner;
    } catch {
      break;
    }
  }
  return msg.replace(/\s+/g, " ").trim().slice(0, 240);
}

/** What went wrong, for the person: a plain sentence plus what the provider itself said. */
export function reason(provider: Provider, e: unknown): { code: "busy" | "key" | "failed"; message: string } {
  const status = (e as { status?: unknown })?.status;
  const said = detail(e);
  console.error("[voice]", provider, typeof status === "number" ? status : "", said);
  const name = PROVIDER_NAME[provider];
  const code =
    status === 429 || /quota|rate limit|resource.?exhausted/i.test(said)
      ? "busy"
      : status === 401 || status === 403 || /api key|permission/i.test(said)
        ? "key"
        : "failed";
  const plain =
    code === "busy"
      ? `${name} says your family's key is out of free requests or busy for now. Wait a minute, or type instead.`
      : code === "key"
        ? `${name} didn't accept your family's key for voice. Ask your family admin to check it.`
        : `${name} couldn't do voice just now. Try again.`;
  return { code, message: said ? `${plain} (${name} said: "${said}")` : plain };
}
