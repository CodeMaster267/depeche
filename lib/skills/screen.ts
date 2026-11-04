/**
 * The first of three checks every skill passes, each time it is made or changed: these rules are
 * free and instant. Then OpenAI's free moderation check (when the family has an OpenAI key) and a
 * model that reads the whole skill looking for anything harmful, sexual or manipulative
 * (lib/skills/check.ts). Any one of them can refuse a skill.
 *
 * Skills are shared with everyone on Depeche and given to models in other people's chats, so the
 * rules look for two things: words that aren't family friendly, and tricks aimed at the model, such
 * as telling it to ignore its rules, reveal memories, or smuggle personal details out in a link.
 */

/** Rude and sexual words. Drugs, violence and self-harm need context, so the model check judges those. */
const BLOCKED = [
  "fuck", "fucking", "fucker", "motherfucker", "shit", "bullshit", "bitch", "bastard", "asshole", "arsehole", "cunt", "twat", "wanker", "slut", "whore", "dickhead",
  "porn", "porno", "pornographic", "pornhub", "nsfw", "xxx", "nudes", "sexting", "onlyfans", "hentai", "fetish", "erotic", "erotica", "camgirl", "blowjob", "handjob",
  "nazi", "swastika", "kkk", "heil",
];
const WORDS = new RegExp(`(^|[^a-z])(${BLOCKED.join("|")})(?=$|[^a-z])`, "i");

/** Letters people swap in to get past filters. */
function unmask(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[@4]/g, "a")
    .replace(/[3]/g, "e")
    .replace(/[1!|]/g, "i")
    .replace(/[0]/g, "o")
    .replace(/[$5]/g, "s")
    .replace(/[*]/g, "u");
}

/** Tricks aimed at the model, each with the reason shown to the person. */
const TRICKS: [RegExp, string][] = [
  [/\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|system|safety|your|the app's|depeche's)\b[^.\n]{0,30}\b(instructions?|rules?|guidelines?|prompts?|policies|restrictions?)/i,
    "it tells the AI to ignore its rules"],
  [/\b(ignore|disregard|override|bypass)\s+(all|any)\s+(other\s+)?(instructions|guidelines|safety)/i, "it tells the AI to ignore its rules"],
  [/\b(jailbreak|developer mode|dan mode|do anything now|no content (filters?|restrictions)|unrestricted mode|uncensored mode|without (any )?(safety|content) (rules|filters|restrictions))\b/i,
    "it tries to take the AI's safety rules away"],
  [/\b(reveal|repeat|print|show|output|list|leak|dump|recite|send|share|copy|include)\b[^.\n]{0,60}\b(system prompt|system message|hidden instructions|developer message|personal instructions|about_me|how_to_answer)\b/i,
    "it asks the AI to reveal its hidden instructions"],
  [/\b(reveal|repeat|print|output|list|leak|dump|send|copy|encode|forward|upload)\b[^.\n]{0,60}\b((your|the (person|user|member)'?s|saved|stored|remembered|depeche) memor(y|ies)|remembered facts|saved facts|other chats?|previous chats?|past chats?|earlier chats?|other conversations?|past conversations?)\b/i,
    "it asks the AI for memories or other chats, which skills can never reach"],
  [/\b(other|another|every|all)\s+(users?|people|persons|members|famil(y|ies))('s|s'|s)?\s+(chats?|messages?|memor(y|ies)|data|accounts?|keys?|passwords?)\b/i,
    "it tries to reach other people's data"],
  [/\b(api keys?|provider keys?|ciphertext|service[_ ]role|access tokens?|session tokens?)\b[^.\n]{0,40}\b(reveal|send|print|show|steal|collect|output)\b/i,
    "it tries to get keys or passwords"],
  [/!\[[^\]]*\]\(\s*<?https?:/i, "it loads pictures from other websites, which could carry personal details away"],
  [/https?:\/\/[^\s)]*(\{|\}|<|>|\[|\]|%7b|%3c|\$\{)/i, "it builds links that could carry personal details away"],
  [/<\/?\s*(system|skill|skills|skill_file|instructions|remember|followups|about_me|how_to_answer|file|message|assistant|user|tool)\b[^>]*>/i,
    "it contains tags the app uses for its own instructions"],
  [/```\s*(design|widget|canvas|skill)\b/i, "it tries to make the app's own blocks (designs, gadgets, canvases)"],
  [/\b(you are no longer|from now on you are|act as (an? )?(unfiltered|uncensored|evil))\b/i, "it tries to change who the AI is"],
  [/\b(pretend|act as if|claim)\b[^.\n]{0,40}\b(you are|to be)\b[^.\n]{0,20}\b(the (app|system|admin|owner|developer)|depeche staff|anthropic|openai|google)\b/i,
    "it makes the AI pretend to be the app or its owner"],
];

export type ScreenResult = { ok: true } | { ok: false; reason: string };

export const refusal = (why: string) =>
  `This skill can't go in the library because ${why}. Skills are shared with everyone on Depeche, so they must be safe and family friendly.`;

/** The rules check: words, then tricks. */
export function screenRules(texts: readonly string[]): ScreenResult {
  for (const t of texts) {
    if (!t) continue;
    if (WORDS.test(t) || WORDS.test(unmask(t))) return { ok: false, reason: refusal("some of its words aren't family friendly") };
    const flat = t.replace(/\s+/g, " ");
    for (const [pattern, why] of TRICKS) if (pattern.test(flat)) return { ok: false, reason: refusal(why) };
  }
  return { ok: true };
}
