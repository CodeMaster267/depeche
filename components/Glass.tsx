"use client";

import { useEffect, useRef } from "react";

/**
 * Liquid glass for Depeche's main buttons (Hasan's "pill with code inside").
 *
 * A main button is a pane of dark glass: thin white rim, a sheen across the top, and behind the
 * label a faint block of monospace "code" with scanlines. The code is bent like thick glass: it is
 * magnified a little in the middle and curves round the rim, and the bend splits it into red and
 * cyan right at the edge (the glitch). A clear patch behind the label keeps it easy to read.
 *
 * How: the code is a known picture inside the button (the page behind is never bent, so it works
 * in Safari). Each <GlassCode> gets an SVG displacement filter whose lens map matches its button's
 * size, built in the browser once the button has a size (before that, the code shows unbent). Nothing in it moves on scroll or while a reply
 * streams; the only live update is the light under the pointer, on the button's own unfiltered layer.
 * Small icon buttons use `.glass` alone: the same smoky glass with no code and no filter.
 */

const ROWS = [
  "f3d9a7c0e1     0x7a21        ::      11001010",
  ">_ send();       ctx=0x19f4         len=4",
  "{ ok:1 }      --        [a9]      01001101",
  "0x6e64      t=42ms          retries=0      >>",
  ">>>     payload=0x2f3b      ...      00101110",
  "crc=0x8c71         <EOF>        0xd3pe",
  "sig=ok      01100100         ack     rx/tx",
];

/** The code pattern inside a main button. Decorative, hidden from screen readers. */
export function GlassCode({ seed = "" }: { seed?: string }) {
  const code = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = code.current;
    if (!el) return;
    const o = observer();
    o.observe(el);
    return () => o.unobserve(el);
  }, []);
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  // Each row is long enough to run past both ends of the widest button.
  const rows = ROWS.map((_, i) => {
    const a = ROWS[(i + h) % ROWS.length], b = ROWS[(i + h + 3) % ROWS.length];
    return `${a}   ${b}   ${a}`;
  });
  return (
    <span aria-hidden="true" className="glass-lens">
      <i ref={code} className="glass-code">
        {rows.map((r, i) => (
          <span key={i} style={{ textIndent: `${((h >> i) % 5) - 2}ch` }}>
            {r}
          </span>
        ))}
      </i>
    </span>
  );
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Lens map for a pill of w×h pixels: red = sideways shift, green = up/down, 128 = none, in units of
 * `reach` (the filter's scale / 2). Every vector points inwards (sampling outside the button would
 * show a see-through band). The middle is magnified slightly; the rim pulls hard towards the
 * centre, which curves the code round the edge. The round ends bend more than the long edges.
 */
function lensMap(w: number, h: number, reach: number): string {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  const r = h / 2;
  // band: how far in from the rim the bend reaches (fraction of the radius).
  const band = 0.85, falloff = 1.5, magnify = 0.05, rimPull = 0.38 * h, flat = 0.35;
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5, py = y + 0.5;
      const cx = Math.min(Math.max(px, r), w - r);
      const dx = px - cx, dy = py - r;
      const d = Math.hypot(dx, dy) || 1;
      const inside = Math.max(0, r - d);
      const pull = Math.pow(Math.max(0, 1 - inside / (band * r)), falloff) * rimPull;
      const nx = dx / d, ny = dy / d;
      const end = Math.min(1, Math.abs(dx) / (r * 0.6));
      // In pixels: magnify towards the centre, then the rim pull.
      const sx = -(px - w / 2) * magnify - nx * pull;
      const sy = -(py - r) * magnify * 2 - ny * pull * (flat + (1 - flat) * end);
      const i = (y * w + x) * 4;
      img.data[i] = 128 + clamp(sx / reach) * 127;
      img.data[i + 1] = 128 + clamp(sy / reach) * 127;
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}

const ready = new Map<string, Promise<string>>();
function ensureFilter(defs: SVGSVGElement, w: number, h: number): Promise<string> {
  const id = `glass-bend-${w}x${h}`;
  let p = ready.get(id);
  if (!p) {
    // Safari draws a filter before its feImage has decoded and doesn't redraw after, so the map
    // is decoded first and the filter is used only once it's ready.
    const url = lensMap(w, h, h * 0.4);
    p = new Promise<string>((resolve) => {
      const img = new Image();
      img.onload = img.onerror = () => {
        buildFilter(defs, id, url, h);
        resolve(id);
      };
      img.src = url;
    });
    ready.set(id, p);
  }
  return p;
}

function buildFilter(defs: SVGSVGElement, id: string, map: string, h: number) {
  const f = document.createElementNS(SVG_NS, "filter");
  const attrs: Record<string, string> = {
    id, x: "0", y: "0", width: "1", height: "1",
    primitiveUnits: "userSpaceOnUse", "color-interpolation-filters": "sRGB",
  };
  for (const [k, v] of Object.entries(attrs)) f.setAttribute(k, v);
  const add = (tag: string, a: Record<string, string>) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(a)) el.setAttribute(k, v);
    f.appendChild(el);
  };
  // No x/y/width/height: the image then fills the filter region (the button) in both engines.
  // Explicit user-space coordinates are placed differently by Safari.
  add("feImage", { href: map, preserveAspectRatio: "none", result: "map" });
  const channels = [
    ["r", (h * 0.9).toFixed(1), "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"],
    ["g", (h * 0.8).toFixed(1), "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"],
    ["b", (h * 0.7).toFixed(1), "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"],
  ];
  for (const [ch, scale, matrix] of channels) {
    add("feDisplacementMap", { in: "SourceGraphic", in2: "map", scale, xChannelSelector: "R", yChannelSelector: "G", result: `d${ch}` });
    add("feColorMatrix", { in: `d${ch}`, type: "matrix", values: matrix, result: ch });
  }
  add("feBlend", { in: "r", in2: "g", mode: "screen", result: "rg" });
  add("feBlend", { in: "rg", in2: "b", mode: "screen" });
  defs.appendChild(f);
}

let defs: SVGSVGElement | null = null;
let sized: ResizeObserver | null = null;

/** The hidden <svg> that holds the filters. Not display:none: some engines then refuse to resolve
 * filters inside it. */
function filterHolder(): SVGSVGElement {
  if (defs?.isConnected) return defs;
  ready.clear();
  defs = document.createElementNS(SVG_NS, "svg");
  defs.setAttribute("aria-hidden", "true");
  defs.setAttribute("width", "0");
  defs.setAttribute("height", "0");
  defs.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
  document.body.appendChild(defs);
  return defs;
}

/** Gives a code layer the filter for its size (again whenever it resizes), and sizes the clear
 * patch behind the label to the label. */
function observer(): ResizeObserver {
  sized ??= new ResizeObserver((entries) => {
    for (const e of entries) {
      const el = e.target as HTMLElement;
      const { width, height } = e.contentRect;
      if (!width || !height) continue;
      const w = Math.round(width / 4) * 4, h = Math.round(height);
      void ensureFilter(filterHolder(), w, h).then((id) => el.style.setProperty("--glass-bend", `url(#${id})`));
      const lens = el.parentElement;
      const button = lens?.parentElement;
      if (lens && button) {
        const label = [...button.children].filter((k) => k !== lens).reduce((sum, k) => sum + k.getBoundingClientRect().width, 0);
        if (label) lens.style.setProperty("--clear", `${Math.round(label)}px`);
      }
    }
  });
  return sized;
}

/** Mounted once: moves the light under the pointer or finger on any glass button. */
export function GlassEffects() {
  useEffect(() => {
    const light = (e: PointerEvent) => {
      const b = (e.target as Element | null)?.closest?.(".glass");
      if (!(b instanceof HTMLElement)) return;
      const r = b.getBoundingClientRect();
      b.style.setProperty("--gx", `${(e.clientX - r.left).toFixed(0)}px`);
      b.style.setProperty("--gy", `${(e.clientY - r.top).toFixed(0)}px`);
    };
    document.addEventListener("pointermove", light, { passive: true });
    document.addEventListener("pointerdown", light, { passive: true });
    return () => {
      document.removeEventListener("pointermove", light);
      document.removeEventListener("pointerdown", light);
    };
  }, []);
  return null;
}
