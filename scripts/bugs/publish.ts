/**
 * Step 5: publish. Runs on a clean copy of main with GitHub write access and the database, and
 * never runs the fixer's code. It applies the patch as text, opens a pull request, merges it only
 * when the gate said so and the Chrome and Safari tests passed, and records the outcome.
 *
 *   node scripts/bugs/publish.ts <work.json> <fix-dir>
 *   env: VERIFY_RESULT (success | failure | skipped | cancelled), NO_MERGE ("true" to never merge)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { oneLine, quoteForMarkdown, run, summary } from "./lib.ts";
import { issueForHasan, type Work } from "./collect.ts";
import type { Decision } from "./policy.ts";
import type { FixResult } from "./prompts.ts";

const [workPath, fixDir] = process.argv.slice(2);
const work = JSON.parse(readFileSync(workPath, "utf8")) as Work;
const read = <T>(name: string, fallback: T): T =>
  existsSync(join(fixDir, name)) ? (JSON.parse(readFileSync(join(fixDir, name), "utf8")) as T) : fallback;
const fix = read<FixResult & { cost_usd?: number }>("result.json", { fixed: false, confident: false, title: "", explanation: "The fixer did not finish.", checked: "" });
const decision = read<Decision & { review?: { verdict: string; reason: string } }>("decision.json", { mode: "none", reasons: ["The gate did not run."] });
const verify = process.env.VERIFY_RESULT ?? "skipped";
const noMerge = process.env.NO_MERGE === "true";

const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const finish = (status: string, note: string, prUrl = "") =>
  run("select public.bug_report_finished(:'id', :'status', :'note', :'pr')", { id: work.id, status, note: note.slice(0, 1000), pr: prUrl });

const what = oneLine(work.summary ?? fix.title ?? "a bug", 70);

if (decision.mode === "none" || decision.mode === "blocked") {
  const why = decision.mode === "none" ? `The fixer couldn't fix it: ${oneLine(fix.explanation, 300)}` : `The fix was thrown away: ${decision.reasons.join("; ")}`;
  issueForHasan(work, what, why, `Triage summary: ${oneLine(work.summary ?? "", 300)}`);
  finish("needs_owner", why);
  summary(`### Result: passed to Hasan\n\n${why}\n`);
  process.exit(0);
}

const branch = `bugfix/${work.id.slice(0, 8)}`;
const testsPassed = verify === "success";
const willMerge = decision.mode === "merge" && testsPassed && !noMerge;

sh("git", ["config", "user.name", "github-actions[bot]"]);
sh("git", ["config", "user.email", "41898299+github-actions[bot]@users.noreply.github.com"]);
sh("git", ["switch", "-c", branch]);
sh("git", ["apply", "--index", "--whitespace=nowarn", join(fixDir, "patch.diff")]);
sh("git", ["commit", "-q", "-m", `${oneLine(fix.title || what, 70)}\n\nAutomatic fix for bug report ${work.id}.`]);
sh("git", ["push", "-q", "--force", "origin", branch]);

const waitWhy = [
  ...(testsPassed ? [] : [`The Chrome and Safari tests ${verify === "failure" ? "failed" : "did not run"}.`]),
  ...(decision.mode === "pr" ? decision.reasons : []),
  ...(noMerge ? ["This run was started with merging turned off."] : []),
];

const body = [
  `**Bug** (${work.from_owner ? "reported from your account" : "reported by a family member"}): ${oneLine(work.summary ?? "", 300)}`,
  "",
  `**What was wrong and what changed:** ${oneLine(fix.explanation, 800)}`,
  "",
  `**Checked by the fixer:** ${oneLine(fix.checked, 300)}`,
  "",
  `**Chrome and Safari tests:** ${testsPassed ? "passed" : verify}`,
  `**Reviewer:** ${decision.review?.verdict ?? "skipped"}${decision.review?.reason ? ` (${oneLine(decision.review.reason, 300)})` : ""}`,
  "",
  willMerge ? "This fix met every rule for merging itself, so it was merged." : `**Waiting for you because:**\n${waitWhy.map((w) => `- ${oneLine(w, 300)}`).join("\n")}`,
  "",
  "<details><summary>The original report (untrusted text)</summary>",
  "",
  quoteForMarkdown(work.body),
  "",
  "</details>",
  "",
  `Fixer cost: $${(fix.cost_usd ?? 0).toFixed(2)}`,
  "",
  "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
].join("\n");

const prUrl = sh("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", `Bug fix: ${oneLine(fix.title || what, 60)}`, "--body", body]);

if (willMerge) {
  try {
    sh("gh", ["pr", "merge", prUrl, "--merge", "--delete-branch"]);
    finish("fixed", "Merged automatically after the Chrome and Safari tests passed.", prUrl);
    summary(`### Result: fixed and merged\n\n${prUrl}\n`);
    process.exit(0);
  } catch {
    waitWhy.push("Merging failed, probably because main changed since the tests ran.");
  }
}
finish("pr_open", waitWhy.join(" ").slice(0, 1000), prUrl);
summary(`### Result: pull request waiting for Hasan\n\n${prUrl}\n\n${waitWhy.map((w) => `- ${w}`).join("\n")}\n`);
