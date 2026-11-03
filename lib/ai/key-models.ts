import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { decryptSecret, fromBytea } from "@/lib/crypto";
import { listKeyModels } from "@/lib/ai/providers";
import type { Provider } from "@/lib/ai/models";

export type KeyModels = { provider: string; models: string[] | null; checked_at: string | null };

const DAY = 86_400_000;

/** Keys whose usable models haven't been checked, or not for a day. */
export function staleKeys(keys: KeyModels[]): KeyModels[] {
  return keys.filter((k) => !k.checked_at || Date.now() - new Date(k.checked_at).getTime() > DAY);
}

/** Asks each provider again which models the family's keys can use, and records the answer. */
export async function refreshKeyModels(familyId: string, providers: string[]): Promise<void> {
  const admin = supabaseAdmin();
  await Promise.all(
    providers.map(async (provider) => {
      const { data } = await admin
        .from("provider_keys")
        .select("ciphertext")
        .eq("family_id", familyId)
        .eq("provider", provider)
        .maybeSingle<{ ciphertext: string }>();
      if (!data) return;
      let key: string;
      try {
        key = decryptSecret(fromBytea(data.ciphertext));
      } catch {
        return;
      }
      const models = await listKeyModels(provider as Provider, key);
      // A refused or unreachable key keeps its last answer; chatting will show the real error.
      if (models) await admin.rpc("set_key_models", { p_family: familyId, p_provider: provider, p_models: models });
    }),
  );
}
