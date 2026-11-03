/**
 * The "Bug-fix rules" check (ci.yml). Runs on every pull request, from main's copy of this script.
 *
 * A pull request that fixes a bug report (branch `bugfix/<n>`, or "Fixes #<n>" in its description,
 * pointing at an issue the mirror opened) is held to scripts/bugs/policy.ts. Who sent the report
 * comes from the `from-hasan` label, and only if the mirror itself added it. The check passes only
 * when the fix may merge without Hasan; otherwise it fails and says why, so it waits for him.
 *
 *   env: PR_BODY, HEAD_REF, BASE_SHA, HEAD_SHA, GH_TOKEN, GH_REPO
 */
import { execFileSync } from "node:child_process";
import { isMain, need, summary } from "./lib.ts";
import { addedLines, decide, parseNumstat } from "./policy.ts";

const MIRROR = "github-actions[bot]";

/** Issue numbers a pull request says it fixes. */
export function linkedIssues(headRef: string, body: string): number[] {
  const found = new Set<number>();
  const branch = /^bugfix\/(\d+)\b/.exec(headRef);
  if (branch) found.add(Number(branch[1]));
  for (const m of body.matchAll(/\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi)) found.add(Number(m[1]));
  return [...found];
}

type LabelEvent = { event: string; label?: { name: string }; actor?: { login: string } };

/** Labels on an issue that were added by the mirror and are still there. */
export function mirrorLabels(events: LabelEvent[]): Set<string> {
  const current = new Map<string, string>();
  for (const e of events) {
    if (!e.label) continue;
    if (e.event === "labeled") current.set(e.label.name, e.actor?.login ?? "");
    if (e.event === "unlabeled") current.delete(e.label.name);
  }
  return new Set([...current].filter(([, by]) => by === MIRROR).map(([name]) => name));
}

const gh = (args: string[]) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function main() {
  const repo = need("GH_REPO");
  const issues = linkedIssues(process.env.HEAD_REF ?? "", process.env.PR_BODY ?? "");
  const reports: { n: number; labels: Set<string>; all: string[] }[] = [];
  for (const n of issues) {
    let events: LabelEvent[];
    let all: string[];
    try {
      events = JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${repo}/issues/${n}/events`])).flat() as LabelEvent[];
      all = (JSON.parse(gh(["api", `repos/${repo}/issues/${n}`])) as { labels: { name: string }[] }).labels.map((l) => l.name);
    } catch {
      continue; // not an issue in this repository
    }
    const labels = mirrorLabels(events);
    if (labels.has("bug-report")) reports.push({ n, labels, all });
  }
  if (!reports.length) {
    console.log("Not a bug-report fix, so these rules don't apply.");
    return;
  }

  // One PR may fix several reports; it is held to the strictest of them.
  const trusted = reports.every((r) => r.labels.has("from-hasan") && !r.labels.has("from-member"));
  const suspicious = reports.some((r) => r.all.includes("suspicious"));
  const base = need("BASE_SHA");
  const head = need("HEAD_SHA");
  const range = `${base}...${head}`;
  const changes = parseNumstat(git("diff", "--numstat", "-M", range), git("diff", "--name-status", "-M", range), git("diff", "--summary", "-M", range));
  const added = addedLines(git("diff", "-U0", "-M", range));
  const d = decide({ trusted, changes, added, fixerConfident: true, reviewOk: true, suspicious });

  const who = trusted ? "Hasan's own account" : "a family member";
  const list = d.reasons.map((r) => `- ${r}`).join("\n");
  if (d.mode === "merge" || d.mode === "none") {
    summary(`### Bug-fix rules: may merge\n\nFixes ${reports.map((r) => `#${r.n}`).join(", ")}, reported from ${who}.\n`);
    return;
  }
  const verdict = d.mode === "blocked" ? "not allowed" : "waits for Hasan";
  summary(`### Bug-fix rules: ${verdict}\n\nReported from ${who}.\n\n${list}\n`);
  console.log(`::error::This bug fix ${verdict}. ${d.reasons.join("; ")}`);
  process.exit(1);
}

if (isMain(import.meta.url)) main();
