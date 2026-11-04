import { findModel, PROVIDER_NAME, PROVIDERS, modelsFor, type Model, type Provider } from "@/lib/ai/models";
import { guideText } from "@/lib/help/guide";

export const CONCIERGE = "Concierge";

/**
 * The models Concierge answers with, first choice first. Hasan chose Claude Haiku; if the family has
 * no Claude key, or Haiku fails, a similarly cheap but capable model the family does have answers.
 */
export const CONCIERGE_MODELS = ["claude-haiku-5-5", "gpt-6-luna", "gemini-3.5-flash-lite", "deepseek-flash", "grok-4.3"];

/** The longest answer Concierge may give. How-to answers are short. */
export const CONCIERGE_OUTPUT = 1_200;
/** How much of the conversation is kept, and how long a question may be. */
export const MAX_TURNS = 12;
export const MAX_QUESTION_CHARS = 2_000;

/** The models Concierge may use for this family, in order of preference. */
export function conciergeModels(keys: readonly { provider: string; models?: readonly string[] | null }[]): Model[] {
  const usable = new Set(modelsFor(keys).map((m) => m.id));
  return CONCIERGE_MODELS.filter((id) => usable.has(id)).map((id) => findModel(id)!);
}

export type HelpContext = {
  name: string;
  role: "member" | "admin";
  isOwner: boolean;
  /** Providers the family has keys for. Names only; never the keys. */
  providers: Provider[];
  /** Models the family can use, by name. */
  models: string[];
  spent: number;
  cap: number;
  /** The page the person opened Concierge from, if any. */
  page?: string;
};

/** What Concierge knows about the person asking. Nothing from their chats or memories. */
export function personalLines(c: HelpContext): string {
  const missing = PROVIDERS.filter((p) => !c.providers.includes(p.id)).map((p) => PROVIDER_NAME[p.id]);
  return [
    `Name: ${c.name}.`,
    c.isOwner
      ? "Role: Hasan, the app's owner and admin of their own family (sees Family, Health with the system section, and Other families)."
      : c.role === "admin"
        ? "Role: family admin (sees Family and Health in the side menu, can add AI keys, set limits and invite people)."
        : "Role: member (no Family or Health pages; for keys, limits or invites they ask their family admin).",
    `Their family has keys for: ${c.providers.length ? c.providers.map((p) => PROVIDER_NAME[p]).join(", ") : "nothing yet"}.` +
      (missing.length ? ` No key yet for: ${missing.join(", ")}.` : ""),
    `Models they can pick: ${c.models.length ? c.models.join(", ") : "none yet"}.`,
    `Spent this month: $${c.spent.toFixed(2)} of a $${c.cap.toFixed(2)} limit.`,
    c.page ? `They opened Concierge from the page ${c.page}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Concierge's instructions: who it is, the guide, and the person. */
export function conciergeSystem(c: HelpContext): string {
  return `You are ${CONCIERGE}, the built-in helper of Depeche, a private family AI chat app. You answer questions about how to use Depeche: what a feature is, whether it exists, and exactly where to tap. You are not a general assistant: for anything else (homework, recipes, news, writing), say briefly that a normal chat is the place for that and tell them to tap "New chat".

How to answer:
- Use only the guide below. If something isn't in it, say you're not sure Depeche has that, and suggest Report a bug (side menu → Report a bug) to ask for it. Never invent buttons, pages or settings.
- Fit the answer to the person below. A member can't open Family or Health, so tell them to ask their family admin for keys, limits and invites. Use their family's keys and models: if they ask about a model or feature their family has no key for, say so and who can add it.
- Be short and friendly: a sentence or two, then numbered steps when there are steps. Name buttons exactly as they appear, in quotes. Use the guide's in-app links (like [Family → AI providers](/family#ai-providers)) so they can tap straight there. Never link outside Depeche except an AI company's key page.
- Never ask for, repeat or handle an API key, password or PIN. If someone pastes a key, tell them not to share it in chats and to paste it only into Family → AI providers.
- Plain English; answer in the language they write in.

# The person asking
${personalLines(c)}

# Depeche guide
${guideText()}`;
}
