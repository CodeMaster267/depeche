/**
 * The family-friendly check, first of three: this quick word check runs on every request and on
 * every bit of text in a finished design. The building model is also told to refuse anything that
 * isn't family friendly, and the request is checked with OpenAI's free moderation check when the
 * family has an OpenAI key. One standard for everyone.
 */
const BLOCKED = [
  "fuck", "fucking", "fucker", "shit", "shitty", "bitch", "bastard", "asshole", "arsehole", "dick", "cock", "pussy", "cunt", "twat", "wanker", "bollocks", "slut", "whore",
  "porn", "porno", "pornhub", "nsfw", "xxx", "nude", "nudes", "naked", "sexy", "sex", "boobs", "tits", "onlyfans", "hentai", "fetish", "stripper",
  "nazi", "swastika", "kkk", "hitler", "isis",
  "cocaine", "heroin", "meth", "weed", "marijuana", "vape", "beer", "vodka", "drunk",
  "gore", "bloody", "corpse", "suicide", "self-harm", "selfharm",
  "casino", "gambling",
];

const PATTERN = new RegExp(`(^|[^a-z])(${BLOCKED.map((w) => w.replace(/[-]/g, "\\-")).join("|")})(?=$|[^a-z])`, "i");

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

/** True when the text is fine for the whole family. */
export function familyFriendly(...texts: (string | undefined)[]): boolean {
  return texts.every((t) => !t || (!PATTERN.test(t) && !PATTERN.test(unmask(t))));
}

export const NOT_FRIENDLY =
  "Depeche keeps every design family friendly, so I can't make that one. Try describing a different look and I'll build it.";
