/**
 * Runs Python a model wrote (to analyse a spreadsheet, say) in the person's own browser, with
 * Pyodide: Python, pandas, numpy and matplotlib compiled for the web, loaded from a public CDN
 * only when someone runs code. Nothing runs on our servers and nothing costs money.
 *
 * Model output is never run in the app's own page (CLAUDE.md). The code runs in a worker inside
 * a sandboxed frame with an opaque origin: it can't see the page, cookies, storage or the session,
 * can't call our API as the person, can't open windows or navigate, and its content security
 * policy lets it reach only the CDN Pyodide comes from (so it can't send the data anywhere).
 * All it can do is post back plain results, which the page checks before showing: text, PNG
 * pictures from matplotlib, and chart descriptions drawn by components/markdown/Chart.tsx.
 */

export const PYODIDE_VERSION = "0.29.5";
const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

export type RunFile = { name: string; bytes: ArrayBuffer; sheets?: { name: string; csv: string }[] };
export type RunEvent =
  | { kind: "status"; text: string }
  | { kind: "text"; text: string }
  | { kind: "error"; text: string }
  | { kind: "image"; data: string }
  | { kind: "chart"; spec: unknown };

/** The longest a run may take before it's stopped. */
export const RUN_TIMEOUT_MS = 120_000;
const MAX_TEXT = 200_000;
const MAX_IMAGE = 6_000_000;

/** Python run before the person's code, once per worker. */
const PRELUDE = String.raw`
import sys, os, io as _io, json as _json, base64 as _b64
import _depeche
os.environ["MPLBACKEND"] = "Agg"
_SHEETS = {}

def _plain(v):
    if hasattr(v, "tolist"):
        return v.tolist()
    if hasattr(v, "item"):
        return v.item()
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return str(v)

def chart(spec=None, *, type=None, x=None, y=None, title=None, **kw):
    """Draw an interactive chart under the code. Pass a dict like the app's chart blocks, or a
    pandas DataFrame with x= (a column, or the index) and y= (a column or list of columns)."""
    if spec is not None and hasattr(spec, "columns"):
        df = spec
        xs = df.index if x is None else df[x]
        ys = [y] if isinstance(y, str) else (list(y) if y is not None else [c for c in df.columns if c != x and str(df[c].dtype) not in ("object", "string")])
        out = {"type": type or "bar", "x": [str(v) for v in list(xs)], "series": [{"name": str(c), "values": df[c].tolist()} for c in ys]}
        if x is not None:
            out.setdefault("xLabel", str(x))
    elif spec is not None and hasattr(spec, "index") and hasattr(spec, "tolist"):
        out = {"type": type or "bar", "x": [str(v) for v in spec.index], "series": [{"name": str(spec.name or ""), "values": spec.tolist()}]}
    else:
        out = dict(spec or {})
        if type is not None:
            out["type"] = type
        if x is not None:
            out["x"] = x
        if y is not None:
            out["series"] = y if isinstance(y, list) and y and isinstance(y[0], dict) else [{"name": "", "values": y}]
    if title is not None:
        out["title"] = title
    out.update(kw)
    _depeche.emit("chart", _json.dumps(_clean(out), default=_plain))

def _clean(v):
    # Missing values (NaN) become gaps in the chart.
    if hasattr(v, "tolist") and not isinstance(v, (str, bytes)):
        v = v.tolist()
    if isinstance(v, dict):
        return {str(k): _clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_clean(x) for x in v]
    if isinstance(v, float) and (v != v or v in (float("inf"), float("-inf"))):
        return None
    return v

def _flush_figures():
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return
    for n in plt.get_fignums():
        buf = _io.BytesIO()
        plt.figure(n).savefig(buf, format="png", dpi=144, bbox_inches="tight")
        _depeche.emit("image", _b64.b64encode(buf.getvalue()).decode())
    plt.close("all")

def _prepare_matplotlib():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.style.use("grayscale")
    plt.show = lambda *a, **k: _flush_figures()

def _prepare_pandas():
    import pandas as pd
    pd.set_option("display.width", 120)
    pd.set_option("display.max_columns", 30)
    pd.set_option("display.max_rows", 60)
    if getattr(pd.read_excel, "_depeche", False):
        return
    original = pd.read_excel
    keep = ("header", "names", "index_col", "usecols", "dtype", "skiprows", "nrows", "parse_dates", "na_values", "thousands", "decimal")
    def read_excel(io, sheet_name=0, **kw):
        sheets = _SHEETS.get(os.path.basename(str(io)))
        if sheets is None:
            return original(io, sheet_name=sheet_name, **kw)
        names = list(sheets)
        def one(k):
            if isinstance(k, int):
                k = names[k]
            if k not in sheets:
                raise ValueError(f"Worksheet named '{k}' not found. Sheets: {names}")
            return pd.read_csv(_io.StringIO(sheets[k]), **{a: b for a, b in kw.items() if a in keep})
        if sheet_name is None:
            return {k: one(k) for k in names}
        if isinstance(sheet_name, list):
            return {k: one(k) for k in sheet_name}
        return one(sheet_name)
    read_excel._depeche = True
    pd.read_excel = read_excel
    class _Book:
        def __init__(self, io, **kw):
            self.sheet_names = list(_SHEETS.get(os.path.basename(str(io)), {}))
            self._io = io
        def parse(self, sheet_name=0, **kw):
            return read_excel(self._io, sheet_name=sheet_name, **kw)
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
    pd.ExcelFile = _Book

def _namespace():
    return {"__name__": "__main__", "chart": chart}

def _show_last(v):
    if v is None:
        return
    _depeche.emit("text", (v.to_string(max_rows=60, max_cols=30) if hasattr(v, "to_string") else repr(v)) + "\n")
`;

/** The worker: loads Pyodide once, then runs each piece of code in a fresh namespace. */
const WORKER = String.raw`
const CDN = ${JSON.stringify(CDN)};
const PRELUDE = ${JSON.stringify(PRELUDE)};
let py = null;
let booting = null;
let current = null;
let sent = 0;
const out = (kind, data) => {
  if (kind === "text" || kind === "error") {
    if (sent > ${MAX_TEXT}) return;
    sent += data.length;
    if (sent > ${MAX_TEXT}) data = data.slice(0, Math.max(0, data.length - (sent - ${MAX_TEXT}))) + "\n[More output was cut off.]\n";
  }
  postMessage({ id: current, kind, data });
};
async function boot() {
  out("status", "Starting Python…");
  importScripts(CDN + "pyodide.js");
  const p = await loadPyodide({ indexURL: CDN });
  p.registerJsModule("_depeche", { emit: (kind, data) => out(String(kind), String(data)) });
  p.setStdout({ batched: (s) => out("text", s + "\n") });
  p.setStderr({ batched: (s) => out("text", s + "\n") });
  p.setStdin({ error: true });
  await p.runPythonAsync(PRELUDE);
  return p;
}
onmessage = async (e) => {
  const m = e.data;
  if (!m || m.type !== "run") return;
  current = m.id;
  sent = 0;
  try {
    py = py || (await (booting = booting || boot()));
    const code = String(m.code);
    out("status", "Loading packages…");
    await py.loadPackagesFromImports(code, { messageCallback: () => {}, errorCallback: () => {} });
    if (/\bpandas\b|\bpd\./.test(code)) await py.loadPackage(["pandas"], { messageCallback: () => {} });
    if (/matplotlib|\bplt\./.test(code)) await py.loadPackage(["matplotlib"], { messageCallback: () => {} });
    // The chat's files, by name, in the folder the code starts in.
    py.FS.mkdirTree("/data");
    py.FS.chdir("/data");
    const sheets = {};
    for (const f of m.files || []) {
      const name = String(f.name).replace(/[\/\x00]/g, "-");
      py.FS.writeFile("/data/" + name, new Uint8Array(f.bytes));
      if (f.sheets) sheets[name] = Object.fromEntries(f.sheets.map((s) => [s.name, s.csv]));
    }
    py.globals.set("_sheets_json", JSON.stringify(sheets));
    await py.runPythonAsync("_SHEETS.clear(); _SHEETS.update(__import__('json').loads(_sheets_json))");
    if (py.loadedPackages.pandas) await py.runPythonAsync("_prepare_pandas()");
    if (py.loadedPackages.matplotlib) await py.runPythonAsync("_prepare_matplotlib()");
    out("status", "Running…");
    const ns = py.runPython("_namespace()");
    try {
      const value = await py.runPythonAsync(code, { globals: ns, filename: "analysis.py" });
      py.globals.get("_show_last")(value);
      if (value && value.destroy) value.destroy();
    } finally {
      ns.destroy();
    }
    if (py.loadedPackages.matplotlib) py.runPython("_flush_figures()");
    postMessage({ id: m.id, kind: "done" });
  } catch (err) {
    let text = String((err && err.message) || err);
    // Keep the part of a traceback about the person's code, not Pyodide's own frames.
    const at = text.indexOf('File "analysis.py"');
    if (at > 0) text = "Traceback (most recent call last):\n  " + text.slice(at);
    out("error", text.trim().split("\n").slice(-25).join("\n"));
    try {
      if (py && py.loadedPackages.matplotlib) py.runPython("_flush_figures()");
    } catch {}
    postMessage({ id: m.id, kind: "done" });
  }
};
`;

const FRAME = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: ${CDN}; worker-src blob:; connect-src ${CDN}">
</head><body><script>
const SOURCE = ${JSON.stringify(WORKER).replace(/</g, "\\u003c")};
let worker = null;
function start() {
  worker = new Worker(URL.createObjectURL(new Blob([SOURCE], { type: "text/javascript" })));
  worker.onmessage = (e) => parent.postMessage(e.data, "*");
  worker.onerror = (e) => { e.preventDefault(); parent.postMessage({ id: null, kind: "crash", data: String(e.message || "Python stopped.") }, "*"); worker.terminate(); worker = null; };
}
addEventListener("message", (e) => {
  if (e.source !== parent) return;
  const m = e.data || {};
  if (m.type === "run") { if (!worker) start(); worker.postMessage(m, (m.files || []).map((f) => f.bytes)); }
  if (m.type === "stop") { if (worker) worker.terminate(); worker = null; }
});
parent.postMessage({ kind: "ready" }, "*");
</script></body></html>`;

let frame: HTMLIFrameElement | null = null;
let ready: Promise<HTMLIFrameElement> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function sandbox(): Promise<HTMLIFrameElement> {
  if (ready && frame?.isConnected) return ready;
  frame?.remove();
  const el = document.createElement("iframe");
  // allow-scripts without allow-same-origin: an opaque origin, cut off from the app.
  el.setAttribute("sandbox", "allow-scripts");
  el.setAttribute("aria-hidden", "true");
  el.tabIndex = -1;
  el.title = "Python";
  el.style.cssText = "position:fixed;width:1px;height:1px;left:-10px;top:-10px;border:0;opacity:0;pointer-events:none";
  el.srcdoc = FRAME;
  frame = el;
  ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Python couldn't start.")), 20_000);
    const onReady = (e: MessageEvent) => {
      if (e.source !== el.contentWindow || (e.data as { kind?: string })?.kind !== "ready") return;
      removeEventListener("message", onReady);
      clearTimeout(timer);
      resolve(el);
    };
    addEventListener("message", onReady);
  });
  document.body.append(el);
  return ready;
}

/** Checks something the sandbox sent before the page uses it. */
export function checkEvent(raw: unknown): RunEvent | "done" | "crash" | null {
  if (!raw || typeof raw !== "object") return null;
  const { kind, data } = raw as { kind?: unknown; data?: unknown };
  if (kind === "done") return "done";
  if (kind === "crash") return "crash";
  if (typeof data !== "string") return null;
  if (kind === "status" || kind === "text" || kind === "error") return { kind, text: data.slice(0, MAX_TEXT) };
  if (kind === "image") return data.length <= MAX_IMAGE && /^[A-Za-z0-9+/]+=*$/.test(data) && data.startsWith("iVBOR") ? { kind, data } : null;
  if (kind === "chart") {
    try {
      return { kind, spec: JSON.parse(data) as unknown };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Runs code and reports what it prints, draws and charts as it goes. One run at a time; others
 * wait their turn. Stop (or the time limit) ends the worker, and the next run starts a fresh one.
 */
export function runPython(code: string, files: RunFile[], onEvent: (e: RunEvent) => void, signal?: AbortSignal): Promise<"done" | "stopped" | "timeout"> {
  const job = queue.then(async () => {
    if (signal?.aborted) return "stopped" as const;
    const el = await sandbox();
    const id = crypto.randomUUID();
    return await new Promise<"done" | "stopped" | "timeout">((resolve) => {
      const finish = (how: "done" | "stopped" | "timeout") => {
        removeEventListener("message", listen);
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        if (how !== "done") el.contentWindow?.postMessage({ type: "stop" }, "*");
        resolve(how);
      };
      const listen = (e: MessageEvent) => {
        if (e.source !== el.contentWindow) return;
        const msg = e.data as { id?: unknown };
        if (msg?.id !== id && msg?.id !== null) return;
        const ev = checkEvent(e.data);
        if (ev === "done") finish("done");
        else if (ev === "crash") {
          onEvent({ kind: "error", text: "Python stopped unexpectedly. It may have run out of memory." });
          finish("stopped");
        } else if (ev) onEvent(ev);
      };
      const stop = () => finish("stopped");
      const timer = setTimeout(() => finish("timeout"), RUN_TIMEOUT_MS);
      addEventListener("message", listen);
      signal?.addEventListener("abort", stop);
      // Copies of the files go over; the originals stay with the page.
      const sent = files.map((f) => ({ ...f, bytes: f.bytes.slice(0) }));
      el.contentWindow?.postMessage({ type: "run", id, code, files: sent }, "*", sent.map((f) => f.bytes));
    });
  });
  queue = job.catch(() => {});
  return job;
}
