/**
 * Memory: lasting facts a person chose to have Depeche remember. A model may suggest one by ending
 * its reply with <remember>…</remember>; that tag is taken out of the reply as it streams and the
 * person decides whether to keep it. Nothing is remembered without their tap.
 */
export const MEMORY_TAG_OPEN = "<remember>";
export const MEMORY_TAG_CLOSE = "</remember>";
export const MAX_MEMORY_CHARS = 300;
/** Memories given to the model with each message, newest first. */
export const MEMORY_PROMPT_LIMIT = 60;

/**
 * Strips <remember>…</remember> from streamed text. Text that might be the start of the tag is held
 * back until it's clear, so the tag never flashes on screen.
 */
export function memoryFilter() {
  let held = "";
  let inside = false;
  let captured = "";
  const suggestions: string[] = [];

  function push(chunk: string): string {
    let text = held + chunk;
    held = "";
    let out = "";
    while (text) {
      if (inside) {
        const end = text.indexOf(MEMORY_TAG_CLOSE);
        if (end < 0) {
          // Keep collecting, but hold back what could be the start of the closing tag.
          const keep = partialSuffix(text, MEMORY_TAG_CLOSE);
          captured += text.slice(0, text.length - keep);
          held = text.slice(text.length - keep);
          return out;
        }
        captured += text.slice(0, end);
        const fact = captured.replace(/\s+/g, " ").trim();
        if (fact) suggestions.push(fact.slice(0, MAX_MEMORY_CHARS));
        captured = "";
        inside = false;
        text = text.slice(end + MEMORY_TAG_CLOSE.length);
        continue;
      }
      const start = text.indexOf(MEMORY_TAG_OPEN);
      if (start < 0) {
        const keep = partialSuffix(text, MEMORY_TAG_OPEN);
        out += text.slice(0, text.length - keep);
        held = text.slice(text.length - keep);
        return out;
      }
      out += text.slice(0, start);
      inside = true;
      text = text.slice(start + MEMORY_TAG_OPEN.length);
    }
    return out;
  }

  /** The end of the stream: whatever was held back is ordinary text after all. */
  function end(): string {
    const rest = inside ? "" : held;
    held = "";
    return rest;
  }

  return { push, end, suggestions };
}

/** How many characters at the end of `text` could be the beginning of `tag`. */
function partialSuffix(text: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) {
    if (tag.startsWith(text.slice(text.length - n))) return n;
  }
  return 0;
}

/** What the model is told about memory: the person's saved facts, and when to suggest one. */
export function memoryInstructions(name: string, memories: string[]): string {
  const known = memories.length
    ? `Things ${name} asked you to remember about them (use them when relevant, without mentioning this list): ${memories.map((m) => `- ${m}`).join(" ")}`
    : "";
  const suggest = [
    `Very rarely, when ${name} tells you a clear, lasting fact about themselves or their life that would help in future chats (like family members' names, where they live, their job, a dietary need, a long-term goal, or how they like answers written), you may suggest remembering it by ending your reply with one line: ${MEMORY_TAG_OPEN}the fact, in the third person${MEMORY_TAG_CLOSE}.`,
    `Do the same if they ask you to remember something. Never suggest one-off details, things about the current task, guesses, anything already remembered, or sensitive details (health, money, passwords) unless they ask. Most replies should not have one, and never more than one.`,
  ].join(" ");
  return [known, suggest].filter(Boolean).join(" ");
}
