/**
 * The models Depeche offers, with list prices used to estimate spending against each person's
 * monthly limit. Prices are dollars per million tokens at the provider's standard rate (checked
 * 3 Nov 2026). Where a provider is running a temporary discount, the normal price is used, so
 * estimates err on the high side and limits are never overshot.
 *
 * A model only appears for a family once its admin has added that provider's key.
 */
export type Provider = "anthropic" | "openai" | "google" | "groq" | "deepseek" | "xai";

export type Model = {
  id: string;
  provider: Provider;
  name: string;
  short: string;
  tags: string[];
  /**
   * Dollars per million tokens. `long` is a dearer rate some providers charge for every token of a
   * request once its input reaches `from` tokens.
   */
  price: { input: number; output: number; long?: { from: number; input: number; output: number } };
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
  {
    id: "groq",
    name: "Groq (open models)",
    keyUrl: "https://console.groq.com/keys",
    keyHint: "Starts with gsk_. The free tier works but is rate-limited (about 30 messages a minute and 1,000 a day per model, and short chats only). Groq handles data under its own terms.",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyHint: "Starts with sk-. Prepaid: add credit at platform.deepseek.com first. No web search. DeepSeek is based in China and handles data under its own terms.",
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    keyUrl: "https://console.x.ai/team/default/api-keys",
    keyHint: "Starts with xai-. Add credit in the xAI console first. Grok can search the web.",
  },
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
  // Groq's free tier costs nothing but is rate-limited. Depeche can't tell a free key from a paid
  // one, so its paid prices are used and limits err high, as with free Gemini keys.
  { id: "openai/gpt-oss-120b", provider: "groq", name: "GPT-OSS 120B (Groq)", short: "GPT-OSS 120B", tags: ["Smart", "Free tier"], price: { input: 0.15, output: 0.6 } },
  { id: "openai/gpt-oss-20b", provider: "groq", name: "GPT-OSS 20B (Groq)", short: "GPT-OSS 20B", tags: ["Fastest", "Free tier"], price: { input: 0.075, output: 0.3 } },
  { id: "qwen/qwen3.8-27b", provider: "groq", name: "Qwen 3.8 27B (Groq)", short: "Qwen 3.8 27B", tags: ["Preview", "Free tier"], price: { input: 0.8, output: 4 } },
  // DeepSeek charges double at busy times (weekday mornings UTC); the busy-time price is used so
  // limits err high. Flash sees pictures; Pro doesn't, so Flash answers messages with pictures.
  { id: "deepseek-v4-pro", provider: "deepseek", name: "DeepSeek V4 Pro", short: "DeepSeek V4 Pro", tags: ["Smart", "Long context"], price: { input: 1.32, output: 3.96 } },
  { id: "deepseek-flash", provider: "deepseek", name: "DeepSeek V4.1 Flash", short: "DeepSeek Flash", tags: ["Fast", "Long context"], price: { input: 0.3, output: 1.2 } },
  // xAI doubles every token's price once a request's input reaches 200,000 tokens.
  { id: "grok-4.7", provider: "xai", name: "Grok 4.7", short: "Grok 4.7", tags: ["Most capable"], price: { input: 2, output: 6, long: { from: 200_000, input: 4, output: 12 } } },
  { id: "grok-4.3", provider: "xai", name: "Grok 4.3", short: "Grok 4.3", tags: ["Fast", "Long context"], price: { input: 1.25, output: 2.5, long: { from: 200_000, input: 2.5, output: 5 } } },
];

/** What a new person starts with, if their family has the provider. */
export const PREFERRED_DEFAULTS = ["claude-sonnet-5-5", "gpt-6.1-sol", "gemini-3.8-flash", "openai/gpt-oss-120b", "grok-4.7", "deepseek-v4-pro"];

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
  const p = priceFor(m, inputTokens);
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

/** The price of a request with this much input: the long-context rate once it applies. */
export function priceFor(m: Model, inputTokens: number): { input: number; output: number } {
  const long = m.price.long;
  return long && inputTokens >= long.from ? long : m.price;
}

export function chooseDefault(available: Model[], last?: string | null): Model | undefined {
  return (
    available.find((m) => m.id === last) ??
    PREFERRED_DEFAULTS.map((id) => available.find((m) => m.id === id)).find(Boolean) ??
    available[0]
  );
}

/**
 * Each provider's fee per web search, in dollars (checked 3 Nov 2026): Anthropic and OpenAI charge
 * $10 per 1,000 searches, Google $14 per 1,000 search queries. Google's monthly free allowance is
 * ignored so estimates err high. The pages a search reads are billed as ordinary input tokens,
 * which the providers already include in their usage reports.
 */
export const SEARCH_PRICE: Record<Provider, number> = { anthropic: 0.01, openai: 0.01, google: 0.014, groq: 0.005, deepseek: 0, xai: 0.005 };

/**
 * Whether Depeche lets this model search the web. On Groq only the GPT-OSS models can, with Groq's
 * browser search ($5 per 1,000 searches on a paid plan; a free key isn't billed, but the fee is still
 * counted so limits err high). Groq retired its Compound search models in October 2026. DeepSeek's
 * API has no web search. xAI's Grok searches with its web_search tool at $5 per 1,000 searches.
 */
export function canSearch(model: Pick<Model, "id" | "provider"> | undefined): boolean {
  if (!model) return true;
  if (model.provider === "deepseek") return false;
  return model.provider !== "groq" || model.id.startsWith("openai/gpt-oss");
}

export const PROVIDER_NAME: Record<Provider, string> = { anthropic: "Anthropic", openai: "OpenAI", google: "Google", groq: "Groq", deepseek: "DeepSeek", xai: "xAI" };

/** The most searches one reply may run, which bounds what a single reply's searching can cost. */
export const MAX_SEARCHES = 5;

export function searchCost(provider: Provider, searches: number): number {
  return Math.max(0, searches) * SEARCH_PRICE[provider];
}
