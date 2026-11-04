import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { decryptSecret, fromBytea } from "@/lib/crypto";
import { listKeyModels } from "@/lib/ai/providers";
import { MODELS, PROVIDER_NAME, type Provider } from "@/lib/ai/models";

export type KeyModels = { provider: string; models: string[] | null; checked_at: string | null };

const DAY = 86_400_000;

/**
 * Picture models were added around then. A key checked before it that lists none of them is asked
 * again, so they show up without waiting a day.
 */
const IMAGES_ADDED = Date.parse("2026-11-04T06:00:00Z");
const PICTURE_MODELS = MODELS.filter((m) => m.image);

/** Keys whose usable models haven't been checked, or not for a day. */
export function staleKeys(keys: KeyModels[]): KeyModels[] {
  return keys.filter((k) => {
    // A key for a provider Depeche no longer offers (an old Groq key) is left alone.
    if (!(k.provider in PROVIDER_NAME)) return false;
    if (!k.checked_at) return true;
    const at = new Date(k.checked_at).getTime();
    const before = at < IMAGES_ADDED && PICTURE_MODELS.some((m) => m.provider === k.provider) && !k.models?.some((id) => PICTURE_MODELS.some((m) => m.id === id));
    return Date.now() - at > DAY || before;
  });
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
