"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { ChartError, fullNumber, niceTicks, parseChart, shortNumber, toChart, type Chart as Spec } from "@/lib/charts/spec";
import { saveFile } from "@/lib/docs/save";

/**
 * Draws a chart from a reply (a ```chart block) or from code the person ran. Everything is drawn
 * here as SVG from checked numbers, never from markup a model wrote. Black and white only: series
 * are told apart by shade, dashes, hatching and marker shape. Hover or tap shows the values; the
 * legend turns series on and off; the data can be read as a table and the chart saved as a picture.
 */

type Style = { stroke: string; dash?: string; fill: string; marker: "circle" | "square" | "triangle" | "diamond" };
const STYLES: Style[] = [
  { stroke: "var(--fg)", fill: "var(--fg)", marker: "circle" },
  { stroke: "var(--mute)", fill: "var(--mute)", marker: "square" },
  { stroke: "var(--fg)", dash: "7 4", fill: "hatch", marker: "triangle" },
  { stroke: "var(--faint)", fill: "var(--faint)", marker: "diamond" },
  { stroke: "var(--fg)", dash: "2 3", fill: "outline", marker: "square" },
  { stroke: "var(--mute)", dash: "7 4", fill: "dots", marker: "circle" },
  { stroke: "var(--faint)", dash: "2 3", fill: "hatch2", marker: "triangle" },
  { stroke: "var(--mute)", dash: "1 5", fill: "outline2", marker: "diamond" },
];

const FONT = 12;
const charW = FONT * 0.58;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

type Hover = { i: number; s?: number; x: number; y: number } | null;

export function Chart({ source, spec: given }: { source?: string; spec?: unknown }) {
  const parsed = useMemo(() => {
    try {
      return { chart: given !== undefined ? toChart(given) : parseChart(source ?? "") };
    } catch (e) {
      return { error: e instanceof ChartError ? e.message : "The chart couldn't be drawn." };
    }
  }, [source, given]);
  const [showSource, setShowSource] = useState(false);

  if (!parsed.chart) {
    return (
      <div className="md-diagram" data-testid="chart" data-failed="true">
        <div className="md-code-bar">
          <span>Chart (couldn&apos;t be drawn: {parsed.error})</span>
        </div>
        {source ? (
          <pre>
            <code>{source}</code>
          </pre>
        ) : null}
      </div>
    );
  }
  return <ChartCard chart={parsed.chart} source={source} showSource={showSource} setShowSource={setShowSource} />;
}

function ChartCard({ chart, source, showSource, setShowSource }: { chart: Spec; source?: string; showSource: boolean; setShowSource: (v: boolean) => void }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const box = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(640);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [hover, setHover] = useState<Hover>(null);
  const [table, setTable] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(240, Math.floor(el.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [table, showSource]);

  const names = chart.type === "scatter" ? chart.points.map((p) => p.name) : chart.type === "pie" ? chart.x : chart.series.map((s) => s.name);
  const legend = chart.type === "pie" || names.filter(Boolean).length > 1 || (names.length === 1 && names[0] && chart.type !== "bar");
  const toggle = (i: number) => {
    if (chart.type === "pie") return;
    const next = new Set(hidden);
    if (next.has(i)) next.delete(i);
    else if (next.size < names.length - 1) next.add(i); // keep at least one
    setHidden(next);
  };

  const drawn = useMemo(() => draw(chart, width, hidden, uid), [chart, width, hidden, uid]);

  async function savePicture() {
    if (!svgRef.current) return;
    setSaving(true);
    try {
      const blob = await picture(svgRef.current, chart, names, drawn.height);
      await saveFile(blob, `${(chart.title ?? "Chart").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80)}.png`);
    } catch {
      // Nothing to do: the chart is still on screen.
    } finally {
      setSaving(false);
    }
  }

  const onKey = (e: KeyboardEvent) => {
    const n = drawn.count;
    if (!n || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
    e.preventDefault();
    const i = hover ? (hover.i + (e.key === "ArrowRight" ? 1 : n - 1)) % n : 0;
    setHover(drawn.at(i));
  };

  return (
    <figure className="md-chart" data-testid="chart" data-type={chart.type}>
      <div className="md-code-bar">
        <span className="min-w-0 truncate">Chart</span>
        <span className="flex shrink-0 items-center gap-4">
          <button type="button" onClick={() => setTable(!table)} aria-pressed={table}>
            {table ? "Chart" : "Data"}
          </button>
          {source ? (
            <button type="button" onClick={() => setShowSource(!showSource)} aria-pressed={showSource}>
              {showSource ? "Hide source" : "Source"}
            </button>
          ) : null}
          <button type="button" onClick={savePicture} disabled={saving || table}>
            {saving ? "Saving…" : "Save"}
          </button>
        </span>
      </div>
      <div className="md-chart-body">
        {chart.title ? <figcaption className="md-chart-title">{chart.title}</figcaption> : null}
        {showSource && source ? (
          <pre className="md-file-source">{source}</pre>
        ) : table ? (
          <DataTable chart={chart} />
        ) : (
          <div
            ref={box}
            className="relative"
            tabIndex={0}
            onKeyDown={onKey}
            onBlur={() => setHover(null)}
            aria-label={`${chart.title ?? "Chart"}. Use the arrow keys to read values, or open Data for a table.`}
          >
            <svg
              ref={svgRef}
              width={width}
              height={drawn.height}
              viewBox={`0 0 ${width} ${drawn.height}`}
              role="img"
              aria-label={chart.title ?? "Chart"}
              className="block touch-pan-y select-none"
              onPointerMove={(e: PointerEvent<SVGSVGElement>) => {
                const r = e.currentTarget.getBoundingClientRect();
                setHover(drawn.hit(e.clientX - r.left, e.clientY - r.top));
              }}
              onPointerDown={(e: PointerEvent<SVGSVGElement>) => {
                const r = e.currentTarget.getBoundingClientRect();
                setHover(drawn.hit(e.clientX - r.left, e.clientY - r.top));
              }}
              onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
            >
              <defs>
                <pattern id={`hatch${uid}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="6" height="6" fill="var(--bg)" />
                  <line x1="0" y1="0" x2="0" y2="6" stroke="var(--fg)" strokeWidth="2.2" />
                </pattern>
                <pattern id={`hatch2${uid}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
                  <rect width="6" height="6" fill="var(--bg)" />
                  <line x1="0" y1="0" x2="0" y2="6" stroke="var(--mute)" strokeWidth="2.2" />
                </pattern>
                <pattern id={`dots${uid}`} width="5" height="5" patternUnits="userSpaceOnUse">
                  <rect width="5" height="5" fill="var(--bg)" />
                  <circle cx="2.5" cy="2.5" r="1.3" fill="var(--fg)" />
                </pattern>
              </defs>
              {drawn.body(hover)}
            </svg>
            {hover ? <Tooltip chart={chart} hover={hover} hidden={hidden} width={width} height={drawn.height} /> : null}
          </div>
        )}
        {legend && !table && !showSource ? (
          <div className="md-chart-legend">
            {names.map((name, i) => (
              <button
                key={i}
                type="button"
                onClick={() => toggle(i)}
                aria-pressed={chart.type === "pie" ? undefined : !hidden.has(i)}
                className={hidden.has(i) ? "opacity-40" : undefined}
                disabled={chart.type === "pie"}
              >
                <Swatch chart={chart} i={i} uid={uid} />
                <span>
                  {name || "Values"}
                  {chart.type === "pie" ? <span className="text-mute"> {percent(chart, i)}</span> : null}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </figure>
  );
}

function percent(chart: Spec, i: number): string {
  const vals = chart.series[0].values as number[];
  const total = vals.reduce((a, b) => a + b, 0);
  const p = (vals[i] / total) * 100;
  return `${p < 1 ? p.toFixed(1) : Math.round(p)}%`;
}

function fillFor(style: Style, uid: string): { fill: string; stroke?: string } {
  if (style.fill === "hatch" || style.fill === "hatch2" || style.fill === "dots") return { fill: `url(#${style.fill}${uid})`, stroke: style.stroke };
  if (style.fill === "outline") return { fill: "var(--bg)", stroke: "var(--fg)" };
  if (style.fill === "outline2") return { fill: "var(--bg)", stroke: "var(--mute)" };
  return { fill: style.fill };
}

/** Pie slices go from full ink to pale, with gaps between them. */
const sliceOpacity = (i: number, n: number) => 1 - (i / Math.max(1, n)) * 0.82;

function Swatch({ chart, i, uid }: { chart: Spec; i: number; uid: string }) {
  const style = STYLES[i % STYLES.length];
  if (chart.type === "pie") {
    return (
      <svg width="14" height="14" aria-hidden>
        <rect x="1" y="1" width="12" height="12" rx="3" fill="var(--fg)" fillOpacity={sliceOpacity(i, chart.x.length)} />
      </svg>
    );
  }
  if (chart.type === "bar") {
    const f = fillFor(style, uid);
    return (
      <svg width="14" height="14" aria-hidden>
        <rect x="1" y="1" width="12" height="12" rx="3" fill={f.fill} stroke={f.stroke} strokeWidth={f.stroke ? 1.5 : 0} />
      </svg>
    );
  }
  return (
    <svg width="26" height="14" aria-hidden>
      <line x1="1" y1="7" x2="25" y2="7" stroke={style.stroke} strokeWidth="2" strokeDasharray={style.dash} />
      <Marker shape={style.marker} x={13} y={7} color={style.stroke} />
    </svg>
  );
}

function Marker({ shape, x, y, color, r = 3.5, ring }: { shape: Style["marker"]; x: number; y: number; color: string; r?: number; ring?: boolean }) {
  const p = { fill: color, stroke: ring ? "var(--bg)" : undefined, strokeWidth: ring ? 1.5 : undefined };
  if (shape === "square") return <rect x={x - r} y={y - r} width={r * 2} height={r * 2} {...p} />;
  if (shape === "triangle") return <path d={`M${x},${y - r * 1.2} L${x + r * 1.15},${y + r * 0.85} L${x - r * 1.15},${y + r * 0.85} Z`} {...p} />;
  if (shape === "diamond") return <path d={`M${x},${y - r * 1.3} L${x + r * 1.3},${y} L${x},${y + r * 1.3} L${x - r * 1.3},${y} Z`} {...p} />;
  return <circle cx={x} cy={y} r={r} {...p} />;
}

function Tooltip({ chart, hover, hidden, width, height }: { chart: Spec; hover: NonNullable<Hover>; hidden: Set<number>; width: number; height: number }) {
  let title = "";
  let rows: [string, string][] = [];
  if (chart.type === "scatter") {
    const s = chart.points[hover.s ?? 0];
    const [x, y] = s.points[hover.i];
    title = s.name;
    rows = [
      [chart.xLabel ?? "x", fullNumber(x, { prefix: "", suffix: "" })],
      [chart.yLabel ?? "y", fullNumber(y, chart)],
    ];
  } else if (chart.type === "pie") {
    title = chart.x[hover.i];
    rows = [[chart.series[0].name || "Value", `${fullNumber(chart.series[0].values[hover.i], chart)} · ${percent(chart, hover.i)}`]];
  } else {
    title = chart.x[hover.i];
    rows = chart.series.flatMap((s, si) => (hidden.has(si) ? [] : [[s.name || chart.yLabel || "Value", fullNumber(s.values[hover.i], chart)] as [string, string]]));
    if (chart.stacked && rows.length > 1) {
      const total = chart.series.reduce((t, s, si) => t + (hidden.has(si) ? 0 : (s.values[hover.i] ?? 0)), 0);
      rows.push(["Total", fullNumber(total, chart)]);
    }
  }
  const w = 190;
  const left = Math.min(Math.max(4, hover.x + 14), width - w - 4);
  const flip = hover.x + 14 + w > width && hover.x - w - 14 > 0;
  const top = Math.min(Math.max(4, hover.y - 20), height - 24 - rows.length * 20);
  return (
    <div role="status" className="md-chart-tip" style={{ left: flip ? hover.x - w - 14 : left, top, maxWidth: w }}>
      {title ? <div className="font-semibold">{title}</div> : null}
      {rows.map(([k, v], i) => (
        <div key={i} className="flex justify-between gap-3">
          <span className="min-w-0 truncate text-mute">{k}</span>
          <span className="tabular-nums">{v}</span>
        </div>
      ))}
    </div>
  );
}

function DataTable({ chart }: { chart: Spec }) {
  if (chart.type === "scatter") {
    return (
      <div className="md-table max-h-80 overflow-auto">
        <table>
          <thead>
            <tr>
              <th>Series</th>
              <th>{chart.xLabel ?? "x"}</th>
              <th>{chart.yLabel ?? "y"}</th>
            </tr>
          </thead>
          <tbody>
            {chart.points.flatMap((s, si) =>
              s.points.map(([x, y], i) => (
                <tr key={`${si}-${i}`}>
                  <td>{s.name}</td>
                  <td>{fullNumber(x, { prefix: "", suffix: "" })}</td>
                  <td>{fullNumber(y, chart)}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="md-table max-h-80 overflow-auto">
      <table>
        <thead>
          <tr>
            <th>{chart.xLabel ?? ""}</th>
            {chart.series.map((s, i) => (
              <th key={i}>{s.name || chart.yLabel || "Value"}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {chart.x.map((label, i) => (
            <tr key={i}>
              <td>{label}</td>
              {chart.series.map((s, si) => (
                <td key={si}>{fullNumber(s.values[i], chart)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Drawn = {
  height: number;
  count: number;
  body: (hover: Hover) => ReactNode;
  hit: (x: number, y: number) => Hover;
  at: (i: number) => Hover;
};

/** Works out where everything goes for this width. */
function draw(chart: Spec, width: number, hidden: Set<number>, uid: string): Drawn {
  if (chart.type === "pie") return drawPie(chart, width);
  if (chart.type === "scatter") return drawScatter(chart, width, hidden);
  return drawCategories(chart, width, hidden, uid);
}

function Axis({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--fg)" strokeWidth="1" />;
}

function drawCategories(chart: Spec, width: number, hidden: Set<number>, uid: string): Drawn {
  const horizontal = chart.type === "bar" && chart.horizontal;
  const visible = chart.series.map((s, i) => ({ s, i })).filter(({ i }) => !hidden.has(i));
  const n = chart.x.length;
  const stacked = chart.stacked && chart.type !== "line" && visible.length > 1;

  // The range of values to show.
  let lo = Infinity;
  let hi = -Infinity;
  for (let c = 0; c < n; c++) {
    if (stacked) {
      let pos = 0;
      let neg = 0;
      for (const { s } of visible) {
        const v = s.values[c] ?? 0;
        if (v >= 0) pos += v;
        else neg += v;
      }
      lo = Math.min(lo, neg);
      hi = Math.max(hi, pos);
    } else {
      for (const { s } of visible) {
        const v = s.values[c];
        if (v === null) continue;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
  }
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  if (chart.type !== "line") {
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }
  const narrow = width < 480;
  const ticks = niceTicks(lo, hi, narrow ? 4 : 5);
  const vMin = ticks[0];
  const vMax = ticks.at(-1)!;
  const tickLabels = ticks.map((t) => shortNumber(t, chart));
  const tickW = Math.max(...tickLabels.map((t) => t.length)) * charW;

  const catChars = Math.min(narrow ? 10 : 16, Math.max(...chart.x.map((l) => l.length)));
  const top = 12;
  let left: number;
  let right = 12;
  let bottom: number;
  let height: number;
  if (horizontal) {
    left = Math.min(width * 0.4, catChars * charW + 12) + (chart.yLabel ? 0 : 0);
    bottom = 26 + (chart.yLabel ? 18 : 0);
    height = Math.min(640, Math.max(160, n * (visible.length > 1 ? 14 * visible.length + 8 : 26) + top + bottom));
    right = Math.max(12, (tickLabels.at(-1)!.length * charW) / 2);
  } else {
    left = tickW + 10 + (chart.yLabel ? 18 : 0);
    bottom = 26 + (chart.xLabel ? 18 : 0);
    height = narrow ? 240 : 300;
  }
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const catLen = horizontal ? plotH : plotW;
  const band = catLen / Math.max(1, n);
  const catPos = (i: number) => (horizontal ? top : left) + band * (i + 0.5);
  const valLen = horizontal ? plotW : plotH;
  const val = (v: number) => {
    const t = (v - vMin) / (vMax - vMin || 1);
    return horizontal ? left + t * valLen : top + plotH - t * valLen;
  };
  // Show every k-th label so they don't run into each other.
  const labelStep = horizontal ? Math.ceil(16 / Math.max(1, band)) : Math.max(1, Math.ceil((catChars * charW + 8) / Math.max(1, band)));

  const at = (i: number): Hover => (horizontal ? { i, x: val(vMax) * 0.5 + left * 0.5, y: catPos(i) } : { i, x: catPos(i), y: top + 8 });
  const hit = (x: number, y: number): Hover => {
    const p = horizontal ? y - top : x - left;
    if (p < 0 || p > catLen || (horizontal ? x < 0 : y > height)) return null;
    const i = Math.min(n - 1, Math.max(0, Math.floor(p / band)));
    return horizontal ? { i, x, y: catPos(i) } : { i, x: catPos(i), y };
  };

  const body = (hover: Hover) => {
    const marks: ReactNode[] = [];
    if (chart.type === "bar") {
      const groupW = band * (stacked ? 0.62 : 0.78);
      const barW = stacked ? groupW : groupW / Math.max(1, visible.length);
      const pos = new Array(n).fill(0);
      const neg = new Array(n).fill(0);
      visible.forEach(({ s, i: si }, k) => {
        const f = fillFor(STYLES[si % STYLES.length], uid);
        for (let c = 0; c < n; c++) {
          const v = s.values[c];
          if (v === null) continue;
          let from = 0;
          let to = v;
          if (stacked) {
            if (v >= 0) {
              from = pos[c];
              to = pos[c] += v;
            } else {
              from = neg[c];
              to = neg[c] += v;
            }
          }
          const a = val(from);
          const b = val(to);
          const offset = catPos(c) - groupW / 2 + (stacked ? 0 : k * barW);
          const thick = Math.max(1, barW - (stacked || visible.length === 1 ? 0 : Math.min(2, barW * 0.15)));
          const rect = horizontal
            ? { x: Math.min(a, b), y: offset, width: Math.max(Math.abs(b - a), v ? 1 : 0), height: thick }
            : { x: offset, y: Math.min(a, b), width: thick, height: Math.max(Math.abs(b - a), v ? 1 : 0) };
          marks.push(
            <rect
              key={`${si}-${c}`}
              {...rect}
              fill={f.fill}
              stroke={f.stroke}
              strokeWidth={f.stroke ? 1.2 : 0}
              opacity={hover && hover.i !== c ? 0.55 : 1}
              data-value={v}
            />,
          );
        }
      });
    } else {
      const base = new Array(n).fill(0);
      visible.forEach(({ s, i: si }) => {
        const style = STYLES[si % STYLES.length];
        const ys = s.values.map((v, c) => (v === null ? null : stacked ? (base[c] += v) : v));
        // Lines break where a value is missing.
        const segments: [number, number][][] = [];
        let cur: [number, number][] = [];
        ys.forEach((v, c) => {
          if (v === null) {
            if (cur.length) segments.push(cur);
            cur = [];
          } else cur.push([catPos(c), val(v)]);
        });
        if (cur.length) segments.push(cur);
        for (const [k, seg] of segments.entries()) {
          const d = seg.map(([x, y], j) => `${j ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
          if (chart.type === "area") {
            const floor = stacked
              ? seg.map(([x], j) => {
                  const c = Math.round((x - left) / band - 0.5);
                  return [x, val((ys[c] ?? 0) - (s.values[c] ?? 0))] as const;
                })
              : seg.map(([x]) => [x, val(Math.max(vMin, Math.min(0, vMax)))] as const);
            const back = [...floor].reverse().map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join("");
            marks.push(<path key={`a${si}-${k}`} d={`${d}${back}Z`} fill={style.stroke} fillOpacity={0.14} />);
          }
          marks.push(
            <path key={`l${si}-${k}`} d={d} fill="none" stroke={style.stroke} strokeWidth={2} strokeDasharray={style.dash} strokeLinejoin="round" strokeLinecap="round" />,
          );
        }
        // Markers when there's room, and always on the point being looked at.
        const roomy = band >= 14;
        ys.forEach((v, c) => {
          if (v === null || (!roomy && hover?.i !== c)) return;
          marks.push(<Marker key={`m${si}-${c}`} shape={style.marker} x={catPos(c)} y={val(v)} color={style.stroke} r={hover?.i === c ? 4.5 : 3} ring />);
        });
      });
    }

    return (
      <>
        {/* Grid lines and value labels. */}
        {ticks.map((t, k) =>
          horizontal ? (
            <g key={k}>
              <line x1={val(t)} x2={val(t)} y1={top} y2={top + plotH} stroke="var(--line)" />
              <text x={val(t)} y={top + plotH + 16} textAnchor="middle" fontSize={FONT} fill="var(--mute)">
                {tickLabels[k]}
              </text>
            </g>
          ) : (
            <g key={k}>
              <line x1={left} x2={left + plotW} y1={val(t)} y2={val(t)} stroke="var(--line)" />
              <text x={left - 6} y={val(t) + 4} textAnchor="end" fontSize={FONT} fill="var(--mute)">
                {tickLabels[k]}
              </text>
            </g>
          ),
        )}
        {hover ? (
          horizontal ? (
            <rect x={left} y={catPos(hover.i) - band / 2} width={plotW} height={band} fill="var(--soft)" />
          ) : (
            <rect x={catPos(hover.i) - band / 2} y={top} width={band} height={plotH} fill="var(--soft)" />
          )
        ) : null}
        {marks}
        {/* The zero line, or the axis. */}
        {horizontal ? <Axis x1={val(Math.max(vMin, Math.min(0, vMax)))} x2={val(Math.max(vMin, Math.min(0, vMax)))} y1={top} y2={top + plotH} /> : <Axis x1={left} x2={left + plotW} y1={val(Math.max(vMin, Math.min(0, vMax)))} y2={val(Math.max(vMin, Math.min(0, vMax)))} />}
        {chart.x.map((label, i) =>
          i % labelStep ? null : horizontal ? (
            <text key={i} x={left - 6} y={catPos(i) + 4} textAnchor="end" fontSize={FONT} fill="var(--fg)">
              {clip(label, catChars)}
            </text>
          ) : (
            <text key={i} x={catPos(i)} y={top + plotH + 16} textAnchor="middle" fontSize={FONT} fill="var(--fg)">
              {clip(label, catChars)}
            </text>
          ),
        )}
        {chart.xLabel && !horizontal ? (
          <text x={left + plotW / 2} y={height - 4} textAnchor="middle" fontSize={FONT} fill="var(--mute)">
            {clip(chart.xLabel, 60)}
          </text>
        ) : null}
        {chart.yLabel ? (
          horizontal ? (
            <text x={left + plotW / 2} y={height - 4} textAnchor="middle" fontSize={FONT} fill="var(--mute)">
              {clip(chart.yLabel, 60)}
            </text>
          ) : (
            <text transform={`translate(12 ${top + plotH / 2}) rotate(-90)`} textAnchor="middle" fontSize={FONT} fill="var(--mute)">
              {clip(chart.yLabel, 40)}
            </text>
          )
        ) : null}
      </>
    );
  };
  return { height, count: n, body, hit, at };
}

function drawScatter(chart: Spec, width: number, hidden: Set<number>): Drawn {
  const narrow = width < 480;
  const height = narrow ? 260 : 320;
  const all = chart.points.flatMap((s, si) => (hidden.has(si) ? [] : s.points));
  const xt = niceTicks(Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[0])), narrow ? 4 : 6);
  const yt = niceTicks(Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[1])), narrow ? 4 : 5);
  const fmtX = (v: number) => shortNumber(v, { prefix: "", suffix: "" });
  const yLabels = yt.map((t) => shortNumber(t, chart));
  const top = 12;
  const left = Math.max(...yLabels.map((l) => l.length)) * charW + 10 + (chart.yLabel ? 18 : 0);
  const right = 14;
  const bottom = 26 + (chart.xLabel ? 18 : 0);
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const px = (v: number) => left + ((v - xt[0]) / (xt.at(-1)! - xt[0] || 1)) * plotW;
  const py = (v: number) => top + plotH - ((v - yt[0]) / (yt.at(-1)! - yt[0] || 1)) * plotH;
  const flat = chart.points.flatMap((s, si) => (hidden.has(si) ? [] : s.points.map((p, i) => ({ si, i, x: px(p[0]), y: py(p[1]) }))));

  const hit = (x: number, y: number): Hover => {
    let best: (typeof flat)[number] | null = null;
    let d = 28 * 28;
    for (const p of flat) {
      const dd = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (dd < d) {
        d = dd;
        best = p;
      }
    }
    return best ? { i: best.i, s: best.si, x: best.x, y: best.y } : null;
  };
  const at = (k: number): Hover => (flat[k] ? { i: flat[k].i, s: flat[k].si, x: flat[k].x, y: flat[k].y } : null);
  const body = (hover: Hover) => (
    <>
      {yt.map((t, k) => (
        <g key={`y${k}`}>
          <line x1={left} x2={left + plotW} y1={py(t)} y2={py(t)} stroke="var(--line)" />
          <text x={left - 6} y={py(t) + 4} textAnchor="end" fontSize={FONT} fill="var(--mute)">
            {yLabels[k]}
          </text>
        </g>
      ))}
      {xt.map((t, k) => (
        <text key={`x${k}`} x={px(t)} y={top + plotH + 16} textAnchor="middle" fontSize={FONT} fill="var(--mute)">
          {fmtX(t)}
        </text>
      ))}
      <Axis x1={left} x2={left + plotW} y1={top + plotH} y2={top + plotH} />
      <Axis x1={left} x2={left} y1={top} y2={top + plotH} />
      {flat.map((p) => {
        const style = STYLES[p.si % STYLES.length];
        const on = hover && hover.s === p.si && hover.i === p.i;
        return <Marker key={`${p.si}-${p.i}`} shape={style.marker} x={p.x} y={p.y} color={style.stroke} r={on ? 5.5 : 3.5} ring />;
      })}
      {chart.xLabel ? (
        <text x={left + plotW / 2} y={height - 4} textAnchor="middle" fontSize={FONT} fill="var(--mute)">
          {clip(chart.xLabel, 60)}
        </text>
      ) : null}
      {chart.yLabel ? (
        <text transform={`translate(12 ${top + plotH / 2}) rotate(-90)`} textAnchor="middle" fontSize={FONT} fill="var(--mute)">
          {clip(chart.yLabel, 40)}
        </text>
      ) : null}
    </>
  );
  return { height, count: flat.length, body, hit, at };
}

function drawPie(chart: Spec, width: number): Drawn {
  const vals = chart.series[0].values as number[];
  const total = vals.reduce((a, b) => a + b, 0);
  const height = Math.min(280, Math.max(200, width * 0.5));
  const cx = width / 2;
  const cy = height / 2;
  const r = height / 2 - 10;
  const inner = r * 0.56;
  const angles: [number, number][] = [];
  let a = -Math.PI / 2;
  for (const v of vals) {
    const span = (v / total) * Math.PI * 2;
    angles.push([a, a + span]);
    a += span;
  }
  const pt = (ang: number, rad: number) => [cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad] as const;
  const hit = (x: number, y: number): Hover => {
    const d = Math.hypot(x - cx, y - cy);
    if (d > r + 4 || d < inner - 4) return null;
    let ang = Math.atan2(y - cy, x - cx);
    if (ang < -Math.PI / 2) ang += Math.PI * 2;
    const i = angles.findIndex(([s, e]) => ang >= s && ang < e);
    return i < 0 ? null : { i, x, y };
  };
  const at = (i: number): Hover => {
    const mid = (angles[i][0] + angles[i][1]) / 2;
    const [x, y] = pt(mid, (r + inner) / 2);
    return { i, x, y };
  };
  const body = (hover: Hover) => (
    <>
      {vals.map((v, i) => {
        const [s, e] = angles[i];
        const grow = hover?.i === i ? 5 : 0;
        const big = e - s > Math.PI ? 1 : 0;
        const full = vals.length === 1;
        const [x1, y1] = pt(s, r + grow);
        const [x2, y2] = pt(e - (full ? 0.0001 : 0), r + grow);
        const [x3, y3] = pt(e - (full ? 0.0001 : 0), inner);
        const [x4, y4] = pt(s, inner);
        const d = `M${x1},${y1} A${r + grow},${r + grow} 0 ${big} 1 ${x2},${y2} L${x3},${y3} A${inner},${inner} 0 ${big} 0 ${x4},${y4} Z`;
        return <path key={i} d={d} fill="var(--fg)" fillOpacity={sliceOpacity(i, vals.length)} stroke="var(--bg)" strokeWidth={2} data-value={v} />;
      })}
      <text x={cx} y={cy - 2} textAnchor="middle" fontSize={11} fill="var(--mute)">
        {hover ? clip(chart.x[hover.i], 16) : "Total"}
      </text>
      <text x={cx} y={cy + 16} textAnchor="middle" fontSize={15} fontWeight={600} fill="var(--fg)">
        {hover ? percent(chart, hover.i) : shortNumber(total, chart)}
      </text>
    </>
  );
  return { height, count: vals.length, body, hit, at };
}

/** The chart as a PNG, with its title and key, in the colours on screen. */
async function picture(svg: SVGSVGElement, chart: Spec, names: string[], height: number): Promise<Blob> {
  const css = getComputedStyle(document.documentElement);
  const colour = (name: string) => css.getPropertyValue(name).trim() || "#000";
  const vars = ["--fg", "--bg", "--mute", "--faint", "--line", "--soft"];
  const resolve = (s: string) => vars.reduce((t, v) => t.replaceAll(`var(${v})`, colour(v)), s);
  const width = Number(svg.getAttribute("width"));
  const head = chart.title ? 34 : 8;
  const shown = names.filter(Boolean);
  const keyRows = shown.length > 1 || chart.type === "pie" ? Math.ceil(shown.length / Math.max(1, Math.floor(width / 150))) : 0;
  const full = head + height + keyRows * 22 + 12;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const perRow = Math.max(1, Math.floor(width / 150));
  const key = shown
    .map((n, i) => {
      const x = 14 + (i % perRow) * 150;
      const y = head + height + 18 + Math.floor(i / perRow) * 22;
      const s = STYLES[i % STYLES.length];
      const swatch =
        chart.type === "pie"
          ? `<rect x="${x}" y="${y - 10}" width="12" height="12" rx="3" fill="var(--fg)" fill-opacity="${sliceOpacity(i, names.length)}"/>`
          : `<rect x="${x}" y="${y - 10}" width="12" height="12" rx="3" fill="${s.stroke}"/>`;
      const label = chart.type === "pie" ? `${n} ${percent(chart, i)}` : n;
      return `${swatch}<text x="${x + 18}" y="${y}" font-size="12" fill="var(--fg)">${esc(clip(label, 20))}</text>`;
    })
    .join("");
  const inner = new XMLSerializer().serializeToString(svg).replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  const markup = resolve(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${full}" viewBox="0 0 ${width} ${full}" font-family="Helvetica, Arial, sans-serif">` +
      `<rect width="100%" height="100%" fill="var(--bg)"/>` +
      (chart.title ? `<text x="14" y="24" font-size="15" font-weight="600" fill="var(--fg)">${esc(chart.title)}</text>` : "") +
      `<g transform="translate(0 ${head})">${inner}</g>${keyRows ? key : ""}</svg>`,
  );
  const img = new Image();
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
  try {
    await new Promise<void>((ok, bad) => {
      img.onload = () => ok();
      img.onerror = () => bad(new Error("image"));
      img.src = url;
    });
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = full * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, full);
    return await new Promise<Blob>((ok, bad) => canvas.toBlob((b) => (b ? ok(b) : bad(new Error("png"))), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}
