/**
 * Shared pieces of the bug-report scripts (.github/workflows/bug-reports.yml and the "Bug-fix
 * rules" check in ci.yml). Runs with Node's built-in TypeScript support and no npm packages, so
 * jobs that hold secrets run nothing but this repository's own code from main.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
