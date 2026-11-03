/**
 * Shared pieces of the daily bug fixer (.github/workflows/bug-fixer.yml). Runs with Node's built-in
 * TypeScript support and no npm packages, so the jobs that hold secrets never install or run
 * anything but this repository's own code from main.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TRIAGE_MODEL = "claude-sonnet-5-5";
export const FIX_MODEL = "claude-opus-5-5";
/** Hard spending ceiling for one fix attempt, enforced by Claude Code itself. */
export const FIX_BUDGET_USD = 3;
/** Most fixes attempted per daily run, to keep cost and GitHub Actions minutes small. */
export const FIXES_PER_RUN = 2;
/** Most new reports read per daily run. */
export const TRIAGE_PER_RUN = 20;

export function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/**
 * Runs SQL against the live database with psql. Values are passed as psql variables and quoted
 * by psql (`:'name'`), never pasted into the SQL text. Returns the rows as JSON objects.
 */
export function sql<T = Record<string, unknown>>(query: string, vars: Record<string, string> = {}): T[] {
  const out = psql(`select coalesce(json_agg(t), '[]'::json) from (${query.trim().replace(/;$/, "")}) t;`, vars);
  return JSON.parse(out.trim() || "[]") as T[];
}

/** Runs one statement (such as a call to a function that returns nothing). */
export function run(statement: string, vars: Record<string, string> = {}) {
  psql(statement.trim().replace(/;?$/, ";"), vars);
}

function psql(input: string, vars: Record<string, string>): string {
  const args = [need("SUPABASE_DB_URL"), "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"];
  for (const [k, v] of Object.entries(vars)) args.push("-v", `${k}=${v}`);
  return execFileSync("psql", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
}

/** True when this file is the script node was asked to run (not just imported). */
export function isMain(moduleUrl: string): boolean {
  return Boolean(process.argv[1]) && fileURLToPath(moduleUrl) === resolve(process.argv[1]);
}

type Tool = { name: string; description: string; input_schema: Record<string, unknown> };

/** One call to the Anthropic Messages API that must answer by filling in `tool`. */
export async function askWithTool<T>(opts: {
  model: string;
  system: string;
  user: string;
  tool: Tool;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}): Promise<T> {
  const res = await (opts.fetchImpl ?? fetch)("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": need("ANTHROPIC_API_KEY"),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 1500,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
      tools: [opts.tool],
      tool_choice: { type: "tool", name: opts.tool.name },
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { content: { type: string; name?: string; input?: unknown }[] };
  const call = body.content.find((c) => c.type === "tool_use" && c.name === opts.tool.name);
  if (!call) throw new Error("The model did not answer with the expected tool");
  return call.input as T;
}

/** Writes a GitHub Actions step output. Values are single-line by construction. */
export function setOutput(name: string, value: string) {
  const file = process.env.GITHUB_OUTPUT;
  const line = `${name}=${value.replace(/[\r\n]+/g, " ")}\n`;
  if (file) appendFileSync(file, line);
  else process.stdout.write(line);
}

/** Appends Markdown to the run's summary page on GitHub. */
export function summary(markdown: string) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, markdown + "\n");
  else process.stdout.write(markdown + "\n");
}

/** Keeps text from a report or a model from breaking out of a Markdown block or mentioning people. */
export function quoteForMarkdown(text: string, max = 2000): string {
  return text
    .slice(0, max)
    .replace(/`/g, "ˋ")
    .replace(/@/g, "@​")
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

/** A single line of plain text, for titles and labels. */
export function oneLine(text: string, max = 80): string {
  const s = text.replace(/\s+/g, " ").replace(/[`@<>]/g, "").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
