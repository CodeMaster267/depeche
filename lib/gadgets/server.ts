import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { decryptSecret, fromBytea } from "@/lib/crypto";
import { chooseDefault, isImageModel, modelsFor, type Model } from "@/lib/ai/models";

export type FamilyKey = { provider: string; models: string[] | null; ciphertext: string };

/** The family's keys, and a way to open one. Keys never leave the server. */
export async function familyKeys(familyId: string) {
  const { data } = await supabaseAdmin()
    .from("provider_keys")
    .select("provider, models, ciphertext")
    .eq("family_id", familyId)
    .returns<FamilyKey[]>();
  const keys = data ?? [];
  const keyOf = (provider: string): string | null => {
    const row = keys.find((k) => k.provider === provider);
    if (!row) return null;
    try {
      return decryptSecret(fromBytea(row.ciphertext));
    } catch {
      return null;
    }
  };
  return { keys, keyOf };
}

/** The chat models a gadget may ask: the family's, without picture makers. */
export function askableModels(keys: readonly FamilyKey[]): Model[] {
  return modelsFor(keys).filter((m) => !isImageModel(m));
}

/**
 * Which AI answers a gadget: the one it asked for if the family has it, else the gadget's chosen
 * one, else the person's usual model.
 */
export function askModel(available: Model[], wanted: string | null, gadgetModel: string | null, lastModel: string | null): Model | undefined {
  for (const id of [wanted, gadgetModel]) {
    const m = id ? available.find((x) => x.id === id) : undefined;
    if (m) return m;
  }
  return chooseDefault(available, lastModel) ?? available[0];
}
