/**
 * Charts in replies. A model draws a chart by writing a ```chart block holding a small JSON
 * description: the kind of chart, the labels along the bottom, and one or more series of numbers.
 * Depeche draws it itself (components/markdown/Chart.tsx), so nothing a model writes is ever run.
 *
 *   {"type":"bar","title":"Spending","x":["Jan","Feb"],"series":[{"name":"Food","values":[120,140]}]}
 *
 * Scatter charts give each point as [x, y]. Everything here is checked and cut to size, since it
 * comes from a model; anything that isn't a chart comes back as an error to show instead.
 */
export type ChartType = "bar" | "line" | "area" | "scatter" | "pie";

export type Series = { name: string; values: (number | null)[] };
export type PointSeries = { name: string; points: [number, number][] };

export type Chart = {
  type: ChartType;
  title?: string;
  /** Labels along the category axis (bar, line, area, pie). */
  x: string[];
  series: Series[];
  /** Scatter charts only. */
  points: PointSeries[];
  xLabel?: string;
  yLabel?: string;
  stacked: boolean;
  horizontal: boolean;
  /** Put before or after every number, like "£" or "%". */
  prefix: string;
  suffix: string;
};

export const MAX_SERIES = 8;
export const MAX_POINTS = 2000;
export const MAX_SLICES = 12;
const MAX_TEXT = 80;

const TYPES: Record<string, ChartType> = {
  bar: "bar",
  bars: "bar",
  column: "bar",
  columns: "bar",
  histogram: "bar",
  line: "line",
  lines: "line",
  area: "area",
  scatter: "scatter",
  point: "scatter",
  points: "scatter",
  pie: "pie",
  donut: "pie",
  doughnut: "pie",
};

const text = (v: unknown, max = MAX_TEXT): string | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return t ? (t.length > max ? `${t.slice(0, max - 1)}…` : t) : undefined;
};

/** A number from a model: numbers, or strings like "1,200", "£40" or "12%". */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.replace(/[,\s£$€¥₹%]/g, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const first = (o: Record<string, unknown>, ...keys: string[]) => keys.map((k) => o[k]).find((v) => v !== undefined);

export class ChartError extends Error {}

/** Reads a ```chart block. Throws ChartError with a short reason if it can't be drawn. */
export function parseChart(source: string): Chart {
  let raw: unknown;
  try {
    raw = JSON.parse(source.trim());
  } catch {
    throw new ChartError("The chart isn't valid JSON.");
  }
  return toChart(raw);
}

export function toChart(raw: unknown): Chart {
  const o = obj(raw);
  if (!o) throw new ChartError("The chart isn't described as an object.");
  const type = TYPES[String(first(o, "type", "kind", "chart") ?? "bar").toLowerCase().trim()];
  if (!type) throw new ChartError("That kind of chart isn't supported.");

  const fmt = obj(o.format) ?? {};
  const chart: Chart = {
    type,
    title: text(o.title, 120),
    x: [],
    series: [],
    points: [],
    xLabel: text(first(o, "xLabel", "x_label", "xTitle")) ?? text(obj(o.x)?.label),
    yLabel: text(first(o, "yLabel", "y_label", "yTitle")) ?? text(obj(o.y)?.label),
    stacked: o.stacked === true,
    horizontal: o.horizontal === true || o.orientation === "horizontal",
    prefix: text(first(fmt, "prefix") ?? o.prefix, 6) ?? "",
    suffix: text(first(fmt, "suffix") ?? o.suffix, 12) ?? "",
  };

  let rawSeries = first(o, "series", "datasets");
  // A single series can be given directly: {"x":[…], "values":[…]} or {"data":[…]}.
  if (!Array.isArray(rawSeries)) {
    const values = first(o, "values", "data", "y");
    rawSeries = values !== undefined ? [{ name: text(o.name) ?? chart.yLabel ?? "", values }] : [];
  }
  const list = (rawSeries as unknown[]).slice(0, MAX_SERIES);

  if (type === "scatter") {
    for (const [i, s] of list.entries()) {
      const so = obj(s);
      const pts = so ? first(so, "points", "values", "data") : s;
      if (!Array.isArray(pts)) continue;
      const points: [number, number][] = [];
      for (const p of pts.slice(0, MAX_POINTS)) {
        const po = obj(p);
        const x = num(Array.isArray(p) ? p[0] : po?.x);
        const y = num(Array.isArray(p) ? p[1] : po?.y);
        if (x !== null && y !== null) points.push([x, y]);
      }
      if (points.length) chart.points.push({ name: text(so?.name) ?? (list.length > 1 ? `Series ${i + 1}` : ""), points });
    }
    if (!chart.points.length) throw new ChartError("The chart has no points to draw.");
    return chart;
  }

  const xs = first(o, "x", "labels", "categories");
  const labels = Array.isArray(xs) ? xs : Array.isArray(obj(xs)?.values) ? (obj(xs)!.values as unknown[]) : [];
  chart.x = labels.slice(0, MAX_POINTS).map((l, i) => text(l) ?? String(i + 1));

  for (const [i, s] of list.entries()) {
    const so = obj(s);
    const vals = so ? first(so, "values", "data", "y") : s;
    if (!Array.isArray(vals)) continue;
    // Values can be plain numbers, or {"label","value"} pairs that also name the categories.
    const values = vals.slice(0, MAX_POINTS).map((v) => {
      const vo = obj(v);
      return vo ? num(first(vo, "value", "y")) : num(v);
    });
    if (!chart.x.length && i === 0) {
      chart.x = vals.slice(0, MAX_POINTS).map((v, j) => text(first(obj(v) ?? {}, "label", "x", "name")) ?? String(j + 1));
    }
    if (values.some((v) => v !== null)) chart.series.push({ name: text(so?.name ?? so?.label) ?? (list.length > 1 ? `Series ${i + 1}` : ""), values });
  }
  if (!chart.series.length) throw new ChartError("The chart has no numbers to draw.");

  const n = Math.max(...chart.series.map((s) => s.values.length));
  while (chart.x.length < n) chart.x.push(String(chart.x.length + 1));
  chart.x = chart.x.slice(0, n);
  for (const s of chart.series) while (s.values.length < n) s.values.push(null);

  if (type === "pie") {
    // One series of slices; negative or missing slices can't be shown.
    const s = chart.series[0];
    const keep = s.values.map((v, i) => [chart.x[i], v] as const).filter(([, v]) => v !== null && v > 0);
    if (!keep.length) throw new ChartError("A pie chart needs positive numbers.");
    let slices = keep.slice(0, MAX_SLICES - 1);
    if (keep.length > MAX_SLICES) {
      const rest = keep.slice(MAX_SLICES - 1).reduce((t, [, v]) => t + (v ?? 0), 0);
      slices = [...slices, ["Other", rest] as const];
    } else slices = keep;
    chart.x = slices.map(([l]) => l);
    chart.series = [{ name: s.name, values: slices.map(([, v]) => v) }];
  }
  return chart;
}

/** Round axis steps: 1, 2, 2.5 or 5 times a power of ten. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const pad = Math.abs(min) || 1;
    min -= pad / 2;
    max += pad / 2;
  }
  const span = max - min;
  const rough = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? 10 * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2 && ticks.length < 50; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

/** A number for an axis: short (12K, 1.5M). */
export function shortNumber(n: number, chart: Pick<Chart, "prefix" | "suffix">): string {
  const s = Math.abs(n) >= 1000 ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n) : String(Number(n.toPrecision(6)));
  return `${n < 0 && chart.prefix ? "-" : ""}${chart.prefix}${n < 0 && chart.prefix ? s.slice(1) : s}${chart.suffix}`;
}

/** A number in full, for tooltips and the data table. */
export function fullNumber(n: number | null, chart: Pick<Chart, "prefix" | "suffix">): string {
  if (n === null) return "–";
  const s = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 6 }).format(Math.abs(n));
  return `${n < 0 ? "-" : ""}${chart.prefix}${s}${chart.suffix}`;
}
