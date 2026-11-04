"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Chart } from "./Chart";
import type { RunEvent, RunFile } from "@/lib/run/sandbox";
import type { FileRef } from "@/lib/chat/files";

/**
 * Python in a reply that Depeche can run, to analyse a spreadsheet or work something out exactly.
 * It runs in a sealed sandbox in the browser (lib/run/sandbox.ts). Blocks written ```python run
 * start by themselves when the reply has just arrived; any other Python block gets a Run button.
 * What it prints, draws and charts appears underneath, and can be sent back to the chat.
 */
export type RunContext = {
  /** Files attached in this chat, which the code can open by name. */
  files: FileRef[];
  /** Run "python run" blocks straight away (the reply has just arrived). */
  autoRun: boolean;
  /** Sends a message in this chat. */
  onSend?: (text: string) => void;
};
export const Runner = createContext<RunContext | null>(null);

type Output = { kind: "text" | "error"; text: string } | { kind: "image"; data: string } | { kind: "chart"; spec: unknown };
type State = { phase: "idle" | "running" | "done" | "stopped"; status?: string; outputs: Output[] };

/** Results by code, so they survive the reply being redrawn (and switching chats). */
const results = new Map<string, State>();
const autoRan = new Set<string>();

const DATA_FILE = /\.(csv|tsv|txt|json|jsonl|xlsx|xml|ya?ml|log|tab|dat)$/i;
const MAX_FILES_BYTES = 40 * 1024 * 1024;

async function loadFiles(code: string, files: FileRef[]): Promise<{ files: RunFile[]; missing: string[] }> {
  // Files the code names, or every data file in the chat if it names none.
  const latest = new Map<string, FileRef>();
  for (const f of files) latest.set(f.name, f);
  const all = [...latest.values()];
  const named = all.filter((f) => code.includes(f.name));
  const want = (named.length ? named : all.filter((f) => DATA_FILE.test(f.name))).slice(0, 10);
  if (!want.length) return { files: [], missing: [] };
  const [{ supabaseBrowser }, { UPLOAD_BUCKET, XLSX }, { xlsxSheets }] = await Promise.all([
    import("@/lib/supabase/browser"),
    import("@/lib/chat/files"),
    import("@/lib/docs/read"),
  ]);
  const storage = supabaseBrowser().storage.from(UPLOAD_BUCKET);
  const out: RunFile[] = [];
  const missing: string[] = [];
  let total = 0;
  for (const f of want) {
    if (total + f.size > MAX_FILES_BYTES) continue;
    const { data } = await storage.download(f.path);
    if (!data) {
      missing.push(f.name);
      continue;
    }
    const bytes = await data.arrayBuffer();
    total += bytes.byteLength;
    let sheets: RunFile["sheets"];
    if (f.mime === XLSX || /\.xlsx$/i.test(f.name)) {
      try {
        sheets = xlsxSheets(new Uint8Array(bytes));
      } catch {
        sheets = undefined;
      }
    }
    out.push({ name: f.name, bytes, sheets });
  }
  return { files: out, missing };
}

export function RunCode({ code, lang, auto, children, streaming }: { code: string; lang: string; auto: boolean; children: ReactNode; streaming: boolean }) {
  const ctx = useContext(Runner);
  const [state, setState] = useState<State>(() => results.get(code) ?? { phase: "idle", outputs: [] });
  const [copied, setCopied] = useState(false);
  const [showCode, setShowCode] = useState(!auto);
  const [sent, setSent] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const update = (fn: (s: State) => State) =>
    setState((s) => {
      const next = fn(s);
      results.set(code, next);
      return next;
    });

  async function run() {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setSent(false);
    update(() => ({ phase: "running", status: "Getting files…", outputs: [] }));
    const push = (o: Output) =>
      update((s) => {
        const last = s.outputs.at(-1);
        // Printed lines join up into one block.
        if (o.kind === "text" && last?.kind === "text") return { ...s, outputs: [...s.outputs.slice(0, -1), { kind: "text", text: last.text + o.text }] };
        return { ...s, outputs: [...s.outputs, o] };
      });
    try {
      const { files, missing } = await loadFiles(code, ctx?.files ?? []);
      for (const name of missing) push({ kind: "error", text: `${name} is no longer available (files are removed after 3 days without use). Attach it again.\n` });
      const { runPython } = await import("@/lib/run/sandbox");
      const how = await runPython(
        code,
        files,
        (e: RunEvent) => {
          if (e.kind === "status") update((s) => ({ ...s, status: e.text }));
          else push(e);
        },
        ac.signal,
      );
      if (how === "timeout") push({ kind: "error", text: "Stopped after 2 minutes.\n" });
      update((s) => ({ ...s, phase: how === "done" ? "done" : "stopped", status: undefined }));
    } catch {
      push({ kind: "error", text: "Python couldn't start. Check your connection and try again.\n" });
      update((s) => ({ ...s, phase: "stopped", status: undefined }));
    }
  }

  useEffect(() => {
    if (!auto || streaming || !ctx?.autoRun || autoRan.has(code) || results.has(code)) return;
    autoRan.add(code);
    run();
    // run() only reads current props; this should fire once per block.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, streaming, ctx?.autoRun, code]);

  const running = state.phase === "running";
  const printed = state.outputs
    .filter((o): o is Extract<Output, { text: string }> => o.kind === "text" || o.kind === "error")
    .map((o) => o.text)
    .join("")
    .trim();

  return (
    <div className="md-run" data-testid="run-code" data-phase={state.phase} data-auto={auto || undefined}>
      <div className="md-code-bar">
        <span>{lang === "python" ? "Python" : lang}</span>
        <span className="flex items-center gap-4">
          {auto ? (
            <button type="button" onClick={() => setShowCode(!showCode)} aria-expanded={showCode}>
              {showCode ? "Hide code" : "Show code"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          {streaming ? null : running ? (
            <button type="button" onClick={() => abort.current?.abort()} className="font-semibold text-fg">
              Stop
            </button>
          ) : (
            <button type="button" onClick={run} className="font-semibold text-fg">
              {state.phase === "idle" ? "Run" : "Run again"}
            </button>
          )}
        </span>
      </div>
      {showCode || streaming ? <pre>{children}</pre> : null}
      {state.phase !== "idle" ? (
        <div className="md-run-out" aria-live="polite">
          {state.outputs.map((o, i) =>
            o.kind === "image" ? (
              // A picture matplotlib drew, checked to be a PNG before it gets here.
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={`data:image/png;base64,${o.data}`} alt="Chart drawn by the code" />
            ) : o.kind === "chart" ? (
              <Chart key={i} spec={o.spec} />
            ) : (
              <div key={i} className={`md-run-text${o.kind === "error" ? " font-semibold" : ""}`} data-testid={o.kind === "error" ? "run-error" : "run-text"}>
                {o.text.replace(/\n$/, "")}
              </div>
            ),
          )}
          {running ? (
            <p className="text-[13px] text-mute" role="status">
              <span className="stream-cursor mr-2 inline-block align-middle" />
              {state.status ?? "Running…"}
            </p>
          ) : state.phase === "stopped" && !state.outputs.length ? (
            <p className="text-[13px] text-mute">Stopped.</p>
          ) : state.phase === "done" && !state.outputs.length ? (
            <p className="text-[13px] text-mute">Ran without printing anything.</p>
          ) : null}
          {!running && printed && ctx?.onSend ? (
            <div className="md-file-more mt-0">
              <button
                type="button"
                disabled={sent}
                onClick={() => {
                  setSent(true);
                  ctx.onSend?.(`Here's what the code printed:\n\n\`\`\`text\n${printed.slice(0, 12_000)}\n\`\`\``);
                }}
              >
                {sent ? "Sent" : "Send results to the chat"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
