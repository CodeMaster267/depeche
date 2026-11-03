import "server-only";
import { NextResponse } from "next/server";
import { getMe, type Me } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { decryptSecret, fromBytea } from "@/lib/crypto";
import type { Provider } from "@/lib/ai/models";
import { voiceProviders } from "@/lib/voice/speech";

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

  const { data: spent } = await admin.rpc("month_spend", { p_person: me.userId });
  const cap = Number(me.profile.monthly_cap_usd);
  if (Number(spent ?? 0) >= cap) {
    return fail(402, `You've reached your $${cap.toFixed(2)} limit for this month. Your family admin can raise it.`);
  }

  try {
    const apiKey = decryptSecret(fromBytea(keys.find((k) => k.provider === provider)!.ciphertext));
    return { me, provider, apiKey };
  } catch {
    return fail(500, "Your family's key needs to be added again. Ask your family admin.");
  }
}

/** Voice costs count against the same monthly limit as chat. Written by the server only. */
export async function recordUsage(me: Me, provider: Provider, model: string, input: number, output: number, cost: number) {
  if (!input && !output && !cost) return;
  await supabaseAdmin().from("usage_events").insert({
    owner_id: me.userId,
    message_id: null,
    provider,
    model,
    input_tokens: Math.max(0, Math.round(input)),
    output_tokens: Math.max(0, Math.round(output)),
    cost_usd: Math.max(0, cost).toFixed(6),
  });
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
