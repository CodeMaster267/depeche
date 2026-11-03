/**
 * What a proposed fix is allowed to change, and whether it may merge itself.
 *
 * This is plain code, not a model, so nothing written in a bug report can argue with it. It runs
 * on a clean copy of main, after the fixer has finished and before anything is pushed.
 *
 *  - Reports from Hasan's own account (`trusted`): the fix may touch most of the app. It merges
 *    itself once the Chrome and Safari tests pass, unless it touches something sensitive (sign-in,
 *    keys, database, dependencies), in which case it waits in a pull request for Hasan.
 *  - Reports from anyone else: the fix may only touch the look and behaviour of the chat screen.
 *    Anything else is thrown away and the report is passed to Hasan. Even an allowed fix waits for
 *    Hasan if it adds network calls, raw HTML, secrets access or anything else unusual, or if the
 *    fixer or the reviewer is unsure.
 *  - Nobody's fix may change the bug pipeline itself, the workflows, or the project rules.
 */

export type Change = { path: string; status: string; added: number; removed: number; binary: boolean; symlink?: boolean };
export type AddedLine = { path: string; text: string };

export type Decision = {
  /** none: nothing changed. blocked: discard, pass to Hasan. pr: open a PR for Hasan. merge: merge after tests. */
  mode: "none" | "blocked" | "pr" | "merge";
  reasons: string[];
};

/** Never changed by the fixer, whoever reported the bug. */
export const ALWAYS_BLOCKED = [
  ".github/",
  ".git/",
  ".bugfix/",
  "scripts/",
  "app/report/",
  "tests/db/",
  "supabase/migrations/20261103030000_bug_reports.sql",
  "CLAUDE.md",
  ".npmrc",
  ".env",
  "vitest.config.ts",
  "playwright.config.ts",
  "e2e/helpers.ts",
  "e2e/setup.spec.ts",
];

/** For Hasan's own reports: allowed, but only through a pull request he merges himself. */
export const OWNER_REVIEW = [
  "supabase/",
  "package.json",
  "package-lock.json",
  "next.config.ts",
  "proxy.ts",
  "tsconfig.json",
  "lib/auth/",
  "lib/supabase/",
  "lib/crypto.ts",
  "lib/config.ts",
  "lib/ai/",
  "app/api/",
  "app/auth/",
  "app/sign-in/",
  "app/setup/",
  "app/invite/",
  "app/family/",
  "app/account/",
  "public/",
];

/** For everyone else: the only places a fix may touch. Anything outside these is blocked. */
export const OTHERS_ALLOWED = [
  "components/",
  "app/c/",
  "app/page.tsx",
  "app/loading.tsx",
  "app/globals.css",
  "lib/markdown.ts",
  "lib/chat/thread.ts",
  "tests/markdown.test.ts",
];
/** Others may add new browser tests, but not change existing ones. */
export const OTHERS_MAY_ADD = ["e2e/"];

/** Patterns in added lines that make a fix wait for Hasan, whoever reported it. */
export const RISKY: [RegExp, string][] = [
  [/https?:\/\//i, "adds a web address"],
  [/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/, "adds a network request"],
  [/\beval\s*\(|new\s+Function\b|\bimport\s*\(/, "runs code dynamically"],
  [/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write|rehype-raw|allowDangerousHtml|skipHtml|urlTransform/, "touches how HTML is rendered"],
  [/<script|<iframe|srcdoc|javascript:/i, "adds a script or frame"],
  [/process\.env|supabaseAdmin|service_?role|serviceRoleKey|SECRET|PASSWORD|api[_-]?key/i, "touches secrets or server access"],
  [/child_process|\bexecSync\b|\bspawn\s*\(/, "runs commands"],
  [/\.rpc\s*\(|\.from\s*\(\s*["'`]/, "changes database access"],
  [/document\.cookie|localStorage|sessionStorage|indexedDB/, "touches stored browser data"],
  [/\batob\s*\(|\bbtoa\s*\(|String\.fromCharCode|\\x[0-9a-f]{2}|\\u00[0-9a-f]{2}/i, "contains encoded text"],
];

export const LIMITS = {
  trusted: { files: 20, lines: 800 },
  others: { files: 8, lines: 200 },
};

const under = (path: string, list: string[]) => list.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));

/** A path that could escape the repository or hide where it points. */
function odd(path: string) {
  return path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "") || /[\0\r\n\\]/.test(path);
}

export function decide(input: {
  trusted: boolean;
  changes: Change[];
  added: AddedLine[];
  fixerConfident: boolean;
  reviewOk: boolean;
  suspicious: boolean;
}): Decision {
  const { trusted, changes, added } = input;
  if (!changes.length) return { mode: "none", reasons: ["The fixer made no changes."] };

  const blocked: string[] = [];
  for (const c of changes) {
    if (odd(c.path)) blocked.push(`${c.path}: unusual path`);
    else if (c.symlink) blocked.push(`${c.path}: symbolic link`);
    else if (under(c.path, ALWAYS_BLOCKED)) blocked.push(`${c.path}: the fixer may never change this`);
    else if (!trusted && !under(c.path, OTHERS_ALLOWED) && !(c.status === "A" && under(c.path, OTHERS_MAY_ADD)))
      blocked.push(`${c.path}: outside what a fix from someone else may touch`);
  }
  if (blocked.length) return { mode: "blocked", reasons: blocked };

  const reasons: string[] = [];
  if (trusted) {
    const sensitive = changes.filter((c) => under(c.path, OWNER_REVIEW)).map((c) => c.path);
    if (sensitive.length) reasons.push(`Touches sensitive files: ${sensitive.join(", ")}`);
  }
  const limit = trusted ? LIMITS.trusted : LIMITS.others;
  const lines = changes.reduce((n, c) => n + c.added + c.removed, 0);
  if (changes.length > limit.files) reasons.push(`Changes ${changes.length} files (limit ${limit.files})`);
  if (lines > limit.lines) reasons.push(`Changes ${lines} lines (limit ${limit.lines})`);
  if (changes.some((c) => c.binary)) reasons.push("Includes a binary file");

  const seen = new Set<string>();
  for (const { path, text } of added) {
    if (/^e2e\/|^tests\//.test(path)) continue; // tests may use addresses and environment settings
    for (const [re, why] of RISKY) {
      if (re.test(text) && !seen.has(why)) {
        seen.add(why);
        reasons.push(`${why} (${path})`);
      }
    }
  }
  if (input.suspicious) reasons.push("The report looked like it was trying to steer the fixer");
  if (!input.fixerConfident) reasons.push("The fixer was not sure about its fix");
  if (!input.reviewOk) reasons.push("The reviewer raised a concern");

  return reasons.length ? { mode: "pr", reasons } : { mode: "merge", reasons: [] };
}

/** Parses `git diff --cached --numstat -z`-free output: "added<TAB>removed<TAB>path" lines. */
export function parseNumstat(numstat: string, nameStatus: string, summary: string): Change[] {
  const status = new Map<string, string>();
  for (const line of nameStatus.split("\n").filter(Boolean)) {
    const [s, ...paths] = line.split("\t");
    status.set(paths[paths.length - 1], s[0]);
  }
  const symlinks = new Set(
    [...summary.matchAll(/mode 120000 (.+)$/gm)].map((m) => m[1].trim()),
  );
  return numstat
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [a, r, ...rest] = line.split("\t");
      const path = rest.join("\t");
      const binary = a === "-" || r === "-";
      return {
        path,
        status: status.get(path) ?? "M",
        added: binary ? 0 : Number(a),
        removed: binary ? 0 : Number(r),
        binary,
        symlink: symlinks.has(path),
      };
    });
}

/** The added lines of a unified diff (`git diff --cached -U0`), with the file each belongs to. */
export function addedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let path = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) path = line.slice(4).replace(/^b\//, "");
    else if (line.startsWith("+") && !line.startsWith("+++")) out.push({ path, text: line.slice(1) });
  }
  return out;
}
