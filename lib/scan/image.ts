/**
 * Turning a photo of a page into a clean, flat scan, all in the browser: find the page's corners,
 * straighten it out (a perspective warp), and even out the lighting so the paper comes out white.
 *
 * Everything here works on plain pixel arrays, so it runs the same in every browser and in tests.
 */
export type Pt = { x: number; y: number };
/** Corners in the photo's pixels: top left, top right, bottom right, bottom left. */
export type Quad = [Pt, Pt, Pt, Pt];
export type Look = "original" | "clean" | "bw";
export type Pixels = { data: Uint8ClampedArray; width: number; height: number };

export const LOOKS: { id: Look; label: string }[] = [
  { id: "clean", label: "Clean" },
  { id: "bw", label: "Black and white" },
  { id: "original", label: "Original" },
];

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** The whole photo, a little in from the edges: used when no page is found. */
export function insetQuad(width: number, height: number, inset = 0.04): Quad {
  const dx = width * inset;
  const dy = height * inset;
  return [
    { x: dx, y: dy },
    { x: width - dx, y: dy },
    { x: width - dx, y: height - dy },
    { x: dx, y: height - dy },
  ];
}

/** Otsu's threshold: the grey level that best splits the picture into dark and light. */
function otsu(gray: Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let at = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      at = t;
    }
  }
  return at;
}

/** Twice the signed area of a polygon. */
function area(q: Pt[]): number {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i];
    const n = q[(i + 1) % q.length];
    a += p.x * n.y - n.x * p.y;
  }
  return a / 2;
}

/** All four corners turn the same way, so the shape is a proper four-sided page. */
export function isConvex(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

/**
 * Finds a sheet of paper in a photo: the largest patch of light pixels, and its four outermost
 * corners. Works best with a page on a darker surface; returns null when nothing page-like stands
 * out, and the person drags the corners themselves.
 *
 * `gray` is a small greyscale copy of the photo (about 200 pixels across is plenty).
 */
export function detectCorners(gray: Uint8Array, width: number, height: number): Quad | null {
  const n = width * height;
  if (n < 64 || gray.length < n) return null;
  const t = otsu(gray);
  const light = new Uint8Array(n);
  for (let i = 0; i < n; i++) light[i] = gray[i] > t ? 1 : 0;

  // The largest connected patch of light pixels.
  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  let bestSize = 0;
  let bestLabel = -1;
  let next = 0;
  for (let start = 0; start < n; start++) {
    if (!light[start] || label[start] !== -1) continue;
    let top = 0;
    let size = 0;
    stack[top++] = start;
    label[start] = next;
    while (top) {
      const i = stack[--top];
      size++;
      const x = i % width;
      const y = (i - x) / width;
      if (x > 0 && light[i - 1] && label[i - 1] === -1) (label[i - 1] = next), (stack[top++] = i - 1);
      if (x < width - 1 && light[i + 1] && label[i + 1] === -1) (label[i + 1] = next), (stack[top++] = i + 1);
      if (y > 0 && light[i - width] && label[i - width] === -1) (label[i - width] = next), (stack[top++] = i - width);
      if (y < height - 1 && light[i + width] && label[i + width] === -1) (label[i + width] = next), (stack[top++] = i + width);
    }
    if (size > bestSize) {
      bestSize = size;
      bestLabel = next;
    }
    next++;
  }
  // A page fills a good part of the photo, but not all of it (then the photo is the page).
  if (bestSize < n * 0.15 || bestSize > n * 0.97) return null;

  // The corners are the patch's points furthest towards each corner of the photo.
  let tl = { x: 0, y: 0, s: Infinity };
  let br = { x: 0, y: 0, s: -Infinity };
  let tr = { x: 0, y: 0, s: -Infinity };
  let bl = { x: 0, y: 0, s: Infinity };
  for (let i = 0; i < n; i++) {
    if (label[i] !== bestLabel) continue;
    const x = i % width;
    const y = (i - x) / width;
    const sum = x + y;
    const diff = x - y;
    if (sum < tl.s) tl = { x, y, s: sum };
    if (sum > br.s) br = { x, y, s: sum };
    if (diff > tr.s) tr = { x, y, s: diff };
    if (diff < bl.s) bl = { x, y, s: diff };
  }
  // Pixel centres to pixel edges, so a page that fills its patch keeps its full size.
  const q: Quad = [
    { x: tl.x, y: tl.y },
    { x: tr.x + 1, y: tr.y },
    { x: br.x + 1, y: br.y + 1 },
    { x: bl.x, y: bl.y + 1 },
  ];
  // A real page's corners enclose most of the patch; a blob that isn't four-sided doesn't.
  if (!isConvex(q) || Math.abs(area(q)) < bestSize * 0.75) return null;
  return q;
}

/** The size a straightened page comes out at: its longest sides, kept within `maxEdge`. */
export function outputSize(q: Quad, maxEdge = 2000): { width: number; height: number } {
  const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  const w = Math.max(d(q[0], q[1]), d(q[3], q[2]));
  const h = Math.max(d(q[0], q[3]), d(q[1], q[2]));
  const scale = Math.min(1, maxEdge / Math.max(w, h, 1));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * The perspective transform taking the output rectangle (0,0)–(w,h) to the page's corners in the
 * photo, as the eight numbers of a 3×3 matrix (the ninth is 1).
 */
export function homography(q: Quad, w: number, h: number): number[] {
  const from: Pt[] = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
  // Eight equations, eight unknowns, solved by Gaussian elimination.
  const m: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const { x: u, y: v } = q[i];
    m.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    m.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let pivot = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
    [m[c], m[pivot]] = [m[pivot], m[c]];
    const p = m[c][c] || 1e-12;
    for (let k = c; k < 9; k++) m[c][k] /= p;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = m[r][c];
      if (!f) continue;
      for (let k = c; k < 9; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row) => row[8]);
}

/** Where an output pixel comes from in the photo. */
export function project(H: number[], x: number, y: number): Pt {
  const z = H[6] * x + H[7] * y + 1;
  return { x: (H[0] * x + H[1] * y + H[2]) / z, y: (H[3] * x + H[4] * y + H[5]) / z };
}

/** Straightens the page inside `q` into a `width`×`height` picture, blending neighbouring pixels. */
export function warp(src: Pixels, q: Quad, width: number, height: number): Pixels {
  const H = homography(q, width, height);
  const out = new Uint8ClampedArray(width * height * 4);
  const { data, width: sw, height: sh } = src;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      const z = H[6] * cx + H[7] * cy + 1;
      const u = Math.min(sw - 1, Math.max(0, (H[0] * cx + H[1] * cy + H[2]) / z - 0.5));
      const v = Math.min(sh - 1, Math.max(0, (H[3] * cx + H[4] * cy + H[5]) / z - 0.5));
      const x0 = Math.floor(u);
      const y0 = Math.floor(v);
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fx = u - x0;
      const fy = v - y0;
      const a = (y0 * sw + x0) * 4;
      const b = (y0 * sw + x1) * 4;
      const c = (y1 * sw + x0) * 4;
      const d = (y1 * sw + x1) * 4;
      const o = (y * width + x) * 4;
      for (let k = 0; k < 3; k++) {
        const top = data[a + k] + (data[b + k] - data[a + k]) * fx;
        const bottom = data[c + k] + (data[d + k] - data[c + k]) * fx;
        out[o + k] = top + (bottom - top) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width, height };
}

/**
 * How bright the paper is around each pixel, from the brightest pixels of each small block, spread
 * over neighbouring blocks so a block full of text still knows its paper is white.
 */
function paperLight(data: Uint8ClampedArray, width: number, height: number): (x: number, y: number) => number {
  const block = Math.max(8, Math.round(Math.max(width, height) / 40));
  const bw = Math.ceil(width / block);
  const bh = Math.ceil(height / block);
  const raw = new Float32Array(bw * bh);
  const hist = new Uint32Array(256);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      hist.fill(0);
      let count = 0;
      for (let y = by * block; y < Math.min(height, (by + 1) * block); y += 2) {
        for (let x = bx * block; x < Math.min(width, (bx + 1) * block); x += 2) {
          const i = (y * width + x) * 4;
          hist[Math.round(luma(data[i], data[i + 1], data[i + 2]))]++;
          count++;
        }
      }
      // The 90th percentile: the paper, not a stray glare.
      let seen = 0;
      let v = 255;
      for (let g = 255; g >= 0; g--) {
        seen += hist[g];
        if (seen >= count * 0.1) {
          v = g;
          break;
        }
      }
      raw[by * bw + bx] = v;
    }
  }
  // Each block takes the brightest of its neighbours, then the map is smoothed.
  const grown = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const yy = by + dy;
          const xx = bx + dx;
          if (yy >= 0 && yy < bh && xx >= 0 && xx < bw) m = Math.max(m, raw[yy * bw + xx]);
        }
      grown[by * bw + bx] = m;
    }
  const smooth = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      let s = 0;
      let c = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const yy = by + dy;
          const xx = bx + dx;
          if (yy >= 0 && yy < bh && xx >= 0 && xx < bw) (s += grown[yy * bw + xx]), c++;
        }
      smooth[by * bw + bx] = Math.max(40, s / c);
    }
  return (x, y) => {
    const fx = Math.min(bw - 1, Math.max(0, x / block - 0.5));
    const fy = Math.min(bh - 1, Math.max(0, y / block - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(bw - 1, x0 + 1);
    const y1 = Math.min(bh - 1, y0 + 1);
    const ax = fx - x0;
    const ay = fy - y0;
    const top = smooth[y0 * bw + x0] * (1 - ax) + smooth[y0 * bw + x1] * ax;
    const bottom = smooth[y1 * bw + x0] * (1 - ax) + smooth[y1 * bw + x1] * ax;
    return top * (1 - ay) + bottom * ay;
  };
}

const smoothstep = (lo: number, hi: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

/**
 * Makes a page look scanned. "clean" evens out shadows and makes the paper white while keeping
 * colour (stamps, highlighter); "bw" makes crisp black text on white; "original" changes nothing.
 * Changes `px` in place and returns it.
 */
export function enhance(px: Pixels, look: Look): Pixels {
  if (look === "original") return px;
  const { data, width, height } = px;
  const paper = paperLight(data, width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const scale = 255 / paper(x, y);
      if (look === "bw") {
        const v = Math.min(1, (luma(data[i], data[i + 1], data[i + 2]) * scale) / 255);
        const g = 255 * smoothstep(0.5, 0.88, v);
        data[i] = data[i + 1] = data[i + 2] = g;
      } else {
        for (let k = 0; k < 3; k++) {
          // Lighting evened out, then a gentle curve: paper to white, ink a little darker.
          const v = Math.min(1, (data[i + k] * scale) / 255);
          data[i + k] = 255 * Math.pow(smoothstep(0.08, 0.94, v), 1.15);
        }
      }
    }
  }
  return px;
}

/** A small greyscale copy of a picture, for finding the page. */
export function shrinkGray(px: Pixels, maxEdge = 200): { gray: Uint8Array; width: number; height: number; scale: number } {
  const scale = Math.min(1, maxEdge / Math.max(px.width, px.height));
  const width = Math.max(1, Math.round(px.width * scale));
  const height = Math.max(1, Math.round(px.height * scale));
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Average the block of photo pixels this one covers.
      const x0 = Math.floor(x / scale);
      const y0 = Math.floor(y / scale);
      const x1 = Math.min(px.width, Math.max(x0 + 1, Math.floor((x + 1) / scale)));
      const y1 = Math.min(px.height, Math.max(y0 + 1, Math.floor((y + 1) / scale)));
      let s = 0;
      let c = 0;
      for (let yy = y0; yy < y1; yy += 2)
        for (let xx = x0; xx < x1; xx += 2) {
          const i = (yy * px.width + xx) * 4;
          s += luma(px.data[i], px.data[i + 1], px.data[i + 2]);
          c++;
        }
      gray[y * width + x] = c ? Math.round(s / c) : 0;
    }
  }
  return { gray, width, height, scale };
}

/** Finds the page in a full-size picture; falls back to the whole picture. */
export function findPage(px: Pixels): { quad: Quad; found: boolean } {
  const small = shrinkGray(px);
  const q = detectCorners(small.gray, small.width, small.height);
  if (!q) return { quad: insetQuad(px.width, px.height), found: false };
  const s = 1 / small.scale;
  // Pulled in a touch, so the edge of the table never shows as a dark line along the page.
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  const pull = 0.012;
  const clamp = (p: Pt) => ({
    x: Math.min(px.width, Math.max(0, (p.x + (cx - p.x) * pull) * s)),
    y: Math.min(px.height, Math.max(0, (p.y + (cy - p.y) * pull) * s)),
  });
  return { quad: q.map(clamp) as Quad, found: true };
}

/** Turns a picture a quarter turn clockwise. */
export function rotate90(px: Pixels): Pixels {
  const { data, width, height } = px;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const nx = height - 1 - y;
      const ny = x;
      const o = (ny * height + nx) * 4;
      out[o] = data[i];
      out[o + 1] = data[i + 1];
      out[o + 2] = data[i + 2];
      out[o + 3] = data[i + 3];
    }
  return { data: out, width: height, height: width };
}
