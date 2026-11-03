/**
 * Step 3: the gate. On a clean copy of main, applies the fixer's patch (without running any of it),
 * checks it against policy.ts, and asks a second model to review the diff. Writes decision.json
 * and sets the `mode` output: none, blocked, pr or merge.
 *
 *   node scripts/bugs/gate.ts <work.json> <fix-dir>
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TRIAGE_MODEL, askWithTool, setOutput, summary } from "./lib.ts";
import { addedLines, decide, parseNumstat, type Decision } from "./policy.ts";
import { REVIEW_SYSTEM, REVIEW_TOOL, reviewMessage, type FixResult } from "./prompts.ts";
import type { Work } from "./collect.ts";

const [workPath, fixDir] = process.argv.slice(2);
const work = JSON.parse(readFileSync(workPath, "utf8")) as Work;
const patchPath = join(fixDir, "patch.diff");
const resultPath = join(fixDir, "result.json");
const fix: FixResult = existsSync(resultPath)
  ? (JSON.parse(readFileSync(resultPath, "utf8")) as FixResult)
  : { fixed: false, confident: false, title: "", explanation: "The fixer did not finish.", checked: "" };

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

async function judge(): Promise<{ decision: Decision; review: { verdict: string; reason: string } }> {
  const skipped = { verdict: "skipped", reason: "" };
  if (!existsSync(patchPath) || statSync(patchPath).size === 0) {
    return { decision: { mode: "none", reasons: [fix.fixed ? "The fix was empty." : "The fixer made no change."] }, review: skipped };
  }
  try {
    git("apply", "--index", "--whitespace=nowarn", patchPath);
  } catch {
    return { decision: { mode: "blocked", reasons: ["The patch didn't apply cleanly to main."] }, review: skipped };
  }
  const changes = parseNumstat(
    git("diff", "--cached", "--numstat", "-M"),
    git("diff", "--cached", "--name-status", "-M"),
    git("diff", "--cached", "--summary", "-M"),
  );
  const added = addedLines(git("diff", "--cached", "-U0", "-M"));
  const base = { trusted: work.from_owner, changes, added, fixerConfident: fix.fixed && fix.confident, suspicious: work.suspicious };
  const first = decide({ ...base, reviewOk: true });
  if (first.mode === "blocked" || first.mode === "none") return { decision: first, review: skipped };

  // The patch is allowed at all, so a second model reviews the diff, without seeing the report.
  let review: { verdict: string; reason: string };
  try {
    review = await askWithTool<{ verdict: string; reason: string }>({
      model: TRIAGE_MODEL,
      system: REVIEW_SYSTEM,
      user: reviewMessage(work.summary ?? "", git("diff", "--cached", "-U3", "-M")),
      tool: REVIEW_TOOL,
      maxTokens: 800,
    });
  } catch (e) {
    review = { verdict: "concern", reason: `The review failed: ${(e as Error).message.slice(0, 200)}` };
  }
  const decision = decide({ ...base, reviewOk: review.verdict === "ok" });
  if (review.verdict !== "ok") decision.reasons = decision.reasons.map((r) => (r === "The reviewer raised a concern" ? `Reviewer: ${review.reason}` : r));
  return { decision, review };
}

const { decision, review } = await judge();
writeFileSync(join(fixDir, "decision.json"), JSON.stringify({ ...decision, review }));
setOutput("mode", decision.mode);
summary(`### Gate: ${decision.mode}\n\n${decision.reasons.map((r) => `- ${r}`).join("\n") || "- All checks passed."}\n`);
