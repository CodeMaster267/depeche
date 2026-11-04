/**
 * Deep research, the parts that don't touch the network: what the model is asked at each step, and
 * how its answers are read. Kept separate so they can be tested on their own.
 *
 * A run goes: plan (3 to 5 research questions), research each question with web search (notes with
 * links), then write the report from the notes, with numbered citations to a numbered source list.
 */
import type { Source } from "@/lib/chat/thread";
import { webSource } from "@/lib/ai/sources";

export const MIN_QUESTIONS = 3;
export const MAX_QUESTIONS = 5;
/** Notes for one question: long enough for detail, short enough that the report's input stays sane. */
export const NOTES_MAX_OUTPUT = 4_000;
/** The report's length for one step. A cut-short report is continued in the next step. */
export const REPORT_MAX_OUTPUT = 12_000;
/** How many times a report cut short by the time limit is continued before it's saved as it is. */
export const MAX_CONTINUATIONS = 2;
/** Sources kept for the report, in the order they were found. */
export const MAX_SOURCES = 40;
/** The last few messages before the question, so a follow-up in a chat makes sense. */
export const CONTEXT_CHARS = 8_000;

export type Note = { question: string; text: string; failed?: boolean };

const today = () =>
  new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

const withContext = (request: string, context: string) =>
  context ? `Earlier in this conversation:\n<conversation>\n${context}\n</conversation>\n\nThe request:\n${request}` : request;

export function planPrompt(request: string, context: string): { system: string; user: string } {
  return {
    system: [
      `You plan deep research reports for Depeche, a private family chat app. Today is ${today()}.`,
      `Break the person's request into ${MIN_QUESTIONS} to ${MAX_QUESTIONS} focused research questions that together cover it well, each answerable by searching the web.`,
      'Reply with JSON only, no other text: {"title": "a short title for the report", "questions": ["…", "…"]}.',
      "Write the title and questions in the language of the request.",
    ].join(" "),
    user: withContext(request, context),
  };
}

/** Reads the model's plan, falling back to researching the request as one question. */
export function parsePlan(text: string, request: string): { title: string; questions: string[] } {
  const fallback = { title: titleOf(request), questions: [request.slice(0, 500)] };
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) return fallback;
  try {
    const parsed = JSON.parse(json) as { title?: unknown; questions?: unknown };
    const questions = Array.isArray(parsed.questions)
      ? parsed.questions
          .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
          .map((q) => q.trim().slice(0, 500))
          .slice(0, MAX_QUESTIONS)
      : [];
    if (!questions.length) return fallback;
    const title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim().slice(0, 200) : titleOf(request);
    return { title, questions };
  } catch {
    return fallback;
  }
}

function titleOf(request: string): string {
  const line = request.trim().split("\n")[0].replace(/\s+/g, " ");
  return line.length <= 80 ? line || "Research report" : `${line.slice(0, 80).trim()}…`;
}

export function notesPrompt(request: string, context: string, questions: string[], index: number): { system: string; user: string } {
  return {
    system: [
      `You are a research assistant gathering facts for a report. Today is ${today()}.`,
      "Search the web as much as you need, using several different searches if it helps, and prefer recent, primary and reputable sources.",
      "Then write detailed research notes that answer the research question: key facts, figures, dates, names, and where sources disagree.",
      "Put each claim's source right after it as a Markdown link, [page title](url). Only cite pages you actually found.",
      "Write notes, not a finished report: no introduction or conclusion. Write in the language of the request.",
    ].join(" "),
    user: `${withContext(request, context)}\n\nResearch question ${index + 1} of ${questions.length}: ${questions[index]}`,
  };
}

/** Links written into the notes, as sources (the provider's own source list may miss some). */
export function linksIn(text: string): Source[] {
  const found: Source[] = [];
  for (const m of text.matchAll(/\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]+)\)/g)) {
    const s = webSource(m[2], m[1]);
    if (s) found.push(s);
  }
  return found;
}

/** Adds sources not seen yet, keeping the order they were found in. */
export function mergeSources(into: Source[], add: Source[]): Source[] {
  const seen = new Set(into.map((s) => normal(s.url)));
  const out = [...into];
  for (const s of add) {
    if (out.length >= MAX_SOURCES) break;
    const key = normal(s.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

const normal = (url: string) => url.replace(/#.*$/, "").replace(/\/$/, "");

export function reportPrompt(
  request: string,
  context: string,
  title: string,
  notes: Note[],
  sources: Source[],
): { system: string; user: string } {
  const list = sources.map((s, i) => `[${i + 1}] ${s.title} (${s.url})`).join("\n");
  const body = notes
    .filter((n) => !n.failed && n.text.trim())
    .map((n, i) => `<notes question="${i + 1}">\nQuestion: ${n.question}\n\n${n.text.trim()}\n</notes>`)
    .join("\n\n");
  return {
    system: [
      `You write deep research reports for Depeche, a private family chat app. Today is ${today()}.`,
      "Write a thorough, well-organised report in Markdown that fully answers the request, based on the research notes you're given.",
      `Start with a # heading (the title, for example "${title.replace(/"/g, "'")}"), then a short "Key findings" list, then sections with ## headings, and end with a short conclusion that answers the request directly.`,
      "Use tables where they help compare things.",
      sources.length
        ? "Cite sources with their numbers from the source list as Markdown links, like [3](https://…), right after the claims they support. Only cite sources from the list, and never make up sources, facts or figures. Say where sources disagree or the evidence is thin. Don't add a source list at the end; the app shows one."
        : "No web sources could be found, so say plainly near the start that this report is from the model's own knowledge and may be out of date, and don't invent citations.",
      "Write in the language of the request.",
    ].join(" "),
    user: `${withContext(request, context)}\n\n${sources.length ? `Source list:\n${list}\n\n` : ""}Research notes:\n\n${body || "(No notes could be gathered.)"}`,
  };
}

/** Asks for the rest of a report that was cut short by the time limit. */
export function continuePrompt(draft: string): string {
  return `Your report so far ends with the text below. Continue it from exactly where it stops, without repeating anything or starting over.\n\n<report-so-far>\n${draft.slice(-6_000)}\n</report-so-far>`;
}
