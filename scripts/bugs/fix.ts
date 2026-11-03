/**
 * Step 2: the fixer. Runs Claude Code on a fresh copy of main for one report.
 *
 * This job holds only the Anthropic key: no database connection and no GitHub write access. For a
 * report from anyone but Hasan, Claude Code gets file tools only (it can't run commands). Its
 * changes leave this job as a patch file; a separate clean job (gate.ts) decides what happens to it.
 *
 *   node scripts/bugs/fix.ts <work.json> <out-dir>
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIX_BUDGET_USD, FIX_MODEL } from "./lib.ts";
import { FIX_SCHEMA, fixerMessage, fixerSystem, type FixResult } from "./prompts.ts";
import type { Work } from "./collect.ts";

const [workPath, outDir] = process.argv.slice(2);
const work = JSON.parse(readFileSync(workPath, "utf8")) as Work;
mkdirSync(outDir, { recursive: true });

const fileTools = ["Read", "Edit", "Write", "Glob", "Grep"];
// Hasan's own reports may also run the project's checks while fixing. Nothing else.
const ownerChecks = ["Bash(npm test)", "Bash(npm run typecheck)", "Bash(npx vitest run *)", "Bash(git diff *)", "Bash(git status)"];
const tools = work.from_owner ? [...fileTools, "Bash"] : fileTools;
const allowed = work.from_owner ? [...fileTools, ...ownerChecks] : fileTools;

const args = [
  "-p",
  fixerMessage(work),
  "--model", FIX_MODEL,
  "--effort", "medium",
  "--max-budget-usd", String(FIX_BUDGET_USD),
  "--append-system-prompt", fixerSystem(work.from_owner),
  "--tools", tools.join(","),
  "--allowedTools", allowed.join(","),
  "--permission-mode", "dontAsk",
  "--strict-mcp-config",
  "--no-session-persistence",
  "--output-format", "json",
  "--json-schema", JSON.stringify(FIX_SCHEMA),
];

const res = spawnSync("claude", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 40 * 60_000 });
let result: FixResult = { fixed: false, confident: false, title: "", explanation: "The fixer did not finish.", checked: "" };
let cost = 0;
try {
  const out = JSON.parse(res.stdout) as { is_error?: boolean; structured_output?: FixResult; result?: string; total_cost_usd?: number };
  cost = out.total_cost_usd ?? 0;
  const r = out.structured_output ?? (out.result ? (JSON.parse(out.result) as FixResult) : undefined);
  if (r && !out.is_error) result = r;
} catch {
  console.log(`::warning::Claude Code exited with ${res.status}. ${(res.stderr ?? "").slice(-500)}`);
}

// Everything the fixer changed, as one patch. Nothing is committed or pushed from here.
execFileSync("git", ["add", "-A"]);
const patch = execFileSync("git", ["diff", "--cached", "--binary"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
writeFileSync(join(outDir, "patch.diff"), result.fixed ? patch : "");
writeFileSync(join(outDir, "result.json"), JSON.stringify({ ...result, cost_usd: cost }));
console.log(`Fixed: ${result.fixed}, confident: ${result.confident}, cost: $${cost.toFixed(2)}, patch: ${patch.length} bytes`);
