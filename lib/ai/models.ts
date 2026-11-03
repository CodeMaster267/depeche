/**
 * The models Depeche offers, with list prices used to estimate spending against each person's
 * monthly limit. Prices are dollars per million tokens at the provider's standard rate (checked
 * 3 Nov 2026). Where a provider is running a temporary discount, the normal price is used, so
 * estimates err on the high side and limits are never overshot.
 *
 * A model only appears for a family once its admin has added that provider's key.
 */
export type Provider = "anthropic" | "openai" | "google";

export type Model = {
  id: string;
  provider: Provider;
  name: string;
  short: string;
  tags: string[];
  price: { input: number; output: number };
};

export const PROVIDERS: { id: Provider; name: string; keyUrl: string; keyHint: string }[] = [
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "Starts with sk-ant-",
  },
  { id: "openai", name: "OpenAI (GPT)", keyUrl: "https://platform.openai.com/api-keys", keyHint: "Starts with sk-" },
  { id: "google", name: "Google (Gemini)", keyUrl: "https://aistudio.google.com/apikey", keyHint: "Starts with AIza. Free keys work for testing, but Google may use free-tier chats to improve its products." },
];

export const MODELS: Model[] = [
  { id: "claude-sonnet-5-5", provider: "anthropic", name: "Claude Sonnet 5.5", short: "Sonnet 5.5", tags: ["Fast", "Smart"], price: { input: 2, output: 10 } },
  { id: "claude-opus-5-5", provider: "anthropic", name: "Claude Opus 5.5", short: "Opus 5.5", tags: ["Deep reasoning"], price: { input: 4, output: 20 } },
  { id: "claude-fable-5-1", provider: "anthropic", name: "Claude Fable 5.1", short: "Fable 5.1", tags: ["Most capable"], price: { input: 10, output: 50 } },
  { id: "claude-haiku-5-5", provider: "anthropic", name: "Claude Haiku 5.5", short: "Haiku 5.5", tags: ["Fastest"], price: { input: 0.1, output: 0.5 } },
  { id: "gpt-6.1-sol", provider: "openai", name: "GPT-6.1 Sol", short: "GPT-6.1 Sol", tags: ["Smart"], price: { input: 2, output: 10 } },
  { id: "gpt-6-astra", provider: "openai", name: "GPT-6 Astra", short: "GPT-6 Astra", tags: ["Most capable"], price: { input: 10, output: 50 } },
  { id: "gpt-6.1-terra", provider: "openai", name: "GPT-6.1 Terra", short: "GPT-6.1 Terra", tags: ["Fast"], price: { input: 1, output: 5 } },
  { id: "gpt-6-luna", provider: "openai", name: "GPT-6 Luna", short: "GPT-6 Luna", tags: ["Fastest"], price: { input: 0.1, output: 0.5 } },
  { id: "gemini-4-argon", provider: "google", name: "Gemini 4 Argon", short: "Gemini 4 Argon", tags: ["Most capable", "Long context"], price: { input: 4, output: 20 } },
  { id: "gemini-3.8-flash", provider: "google", name: "Gemini 3.8 Flash", short: "Gemini 3.8 Flash", tags: ["Fast"], price: { input: 1.5, output: 7.5 } },
  { id: "gemini-3.5-flash-lite", provider: "google", name: "Gemini 3.5 Flash-Lite", short: "Flash-Lite", tags: ["Fastest"], price: { input: 0.3, output: 2.5 } },
];

/** What a new person starts with, if their family has the provider. */
export const PREFERRED_DEFAULTS = ["claude-sonnet-5-5", "gpt-6.1-sol", "gemini-3.8-flash"];

export function findModel(id: string | null | undefined): Model | undefined {
  return MODELS.find((m) => m.id === id);
}

/**
 * The models a family can use: those of providers it has a key for, narrowed to the ones each key
 * can actually use once that has been checked (`models` null means not checked yet).
 */
export function modelsFor(keys: readonly { provider: string; models?: readonly string[] | null }[]): Model[] {
  return MODELS.filter((m) =>
    keys.some((k) => k.provider === m.provider && (!k.models?.length || k.models.includes(m.id))),
  );
}

/** Price band shown in the picker: $ to $$$$. */
export function priceBand(m: Model): string {
  const blended = m.price.input + m.price.output * 3;
  return blended < 10 ? "$" : blended < 40 ? "$$" : blended < 100 ? "$$$" : "$$$$";
}

/** Estimated cost of one reply, in dollars. */
export function estimateCost(m: Model, inputTokens: number, outputTokens: number): number {
  return (inputTokens * m.price.input + outputTokens * m.price.output) / 1_000_000;
}

export function chooseDefault(available: Model[], last?: string | null): Model | undefined {
  return (
    available.find((m) => m.id === last) ??
    PREFERRED_DEFAULTS.map((id) => available.find((m) => m.id === id)).find(Boolean) ??
    available[0]
  );
}
