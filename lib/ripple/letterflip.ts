/**
 * The letterflip ripple (roadmap item 4), after igloo.inc's project pages.
 *
 * A field of faint lowercase monospace letters sits behind the page. Moving a mouse over it paints
 * into a low-resolution simulation grid (one cell per 5 CSS px). Every frame each cell becomes the
 * largest of its four neighbours times 0.985, read through a fixed wobble, so every stroke grows
 * outwards as a ragged ring and fades. Each letter reads the cell under its centre:
 *  - strong value: the faint letter turns full ink (white in dark mode, black in light mode);
 *  - rising value (this frame minus last): the letter flips to a stand-in character with a small
 *    red/cyan channel split, the only colour, as in the rest of Depeche's glitch.
 *
 * On touch screens (no mouse to follow) two unseen wanderers paint in slow bursts instead, so the
 * field drifts like waves on its own.
 *
 * Everything runs on the GPU (WebGL2): the simulation ping-pongs between two half-float textures and
 * the letters are drawn from a glyph atlas in one full-screen pass. The CPU only tracks the mouse.
 * The loop starts on mouse movement and stops itself once the ripple has faded, so an idle page
 * costs nothing. All the simulation constants follow the reference implementation
 * (Hasan's ripple-effect-context.md, the arabicwithesa.com port of igloo's effect).
 *
 * The field is decoration: the canvas is aria-hidden and never takes pointer events.
 */

const CELL = 5; // simulation cell, CSS px
const MARGIN = 48; // how far outside the field the mouse still counts
const DECAY = 0.985;
const FONT_PX = 13;
const LINE = 20; // letter row height, CSS px
const FEATHER = 36; // soft edge round areas kept clear of letters, CSS px
const MAX_CLEAR = 4;
const SLOW_KEY = "depeche-ripple-slow";
const STANDINS = "abcdeghknopqsuvxyz0123456789^][_/\\<>=+*#%&?!:;.";
const RED = [1, 0x1e / 255, 0x3c / 255];
const CYAN = [0, 0xe5 / 255, 1];

export type RippleMode = "mouse" | "ambient";

/**
 * How this device gets the effect. With a real mouse (and no touch screen, so iPads with a trackpad
 * count as touch) the ripple follows the pointer. On phones, tablets and touch screens it drifts on
 * its own, like slow waves, never tied to a finger. Nothing at all for anyone who asked for less motion.
 */
export function rippleMode(): RippleMode | null {
  if (typeof window === "undefined" || typeof matchMedia !== "function") return null;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  const mouse = matchMedia("(hover: hover) and (pointer: fine)").matches && (navigator.maxTouchPoints ?? 0) === 0;
  return mouse ? "mouse" : "ambient";
}

export type LetterflipOptions = {
  /** The words the field repeats. */
  text: string;
  /** Elements (inside the canvas's parent) to keep clear of letters, so what people read stays clean. */
  clearSelector?: string;
  /** "mouse" follows the pointer; "ambient" drifts on its own (touch screens). */
  mode?: RippleMode;
};

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const WARP = `
uniform vec2 phase;
uniform float warpK; // CELL / innerHeight
vec2 warp(vec2 c) {
  float u = c.x * warpK, v = c.y * warpK;
  return vec2(
    c.x + sin(u * 19.0 + phase.x) * 0.6 + sin(v * 31.0 - u * 7.0 + phase.y) * 0.4,
    c.y + sin(v * 23.0 + phase.y) * 0.6 + sin(u * 29.0 + v * 11.0 + phase.x) * 0.4
  );
}`;

const SIM = `#version 300 es
precision highp float;
uniform sampler2D prev;
uniform vec2 size;   // simulation size in cells
uniform vec4 seg[2];     // strokes from (x, y) to (z, w), in cells
uniform float radius[2]; // stroke radii in cells, 0 = no stroke
${WARP}
out vec4 o;
float at(vec2 c) { return texture(prev, (c + 0.5) / size).r; }
void main() {
  vec2 c = floor(gl_FragCoord.xy);
  vec2 q = warp(c);
  float next = max(max(at(q - vec2(1.0, 0.0)), at(q + vec2(1.0, 0.0))),
                   max(at(q - vec2(0.0, 1.0)), at(q + vec2(0.0, 1.0)))) * ${DECAY};
  for (int i = 0; i < 2; i++) {
    if (radius[i] <= 0.0) continue;
    vec2 a = seg[i].xy, s = seg[i].zw - seg[i].xy;
    float h = clamp(dot(c - a, s) / max(dot(s, s), 1e-6), 0.0, 1.0);
    float k = 1.0 - length(c - a - s * h) / radius[i];
    if (k > 0.0) next = min(1.0, next + k * k * k * ${DECAY});
  }
  o = vec4(next, 0.0, 0.0, 1.0);
}`;

/** One texel per letter: what it shows and how bright, worked out once per letter, not per pixel. */
const LETTERS = `#version 300 es
precision highp float;
uniform sampler2D cur, prev, state;
uniform vec2 simSize;
uniform vec2 view;      // canvas size, CSS px
uniform vec2 cell;      // letter cell, CSS px
uniform float standBase, standCount;
uniform float rest;     // opacity of a letter at rest
uniform vec4 clearRects[${MAX_CLEAR}]; // x0, y0, x1, y1 in CSS px from the top left
uniform int clearCount;
${WARP}
out vec4 o;

void main() {
  ivec2 ci = ivec2(gl_FragCoord.xy); // column, row from the top
  vec4 st = texelFetch(state, ci, 0);
  float g = floor(st.r * 255.0 + 0.5);
  if (g < 0.5) { o = vec4(0.0); return; }
  float seed = floor(st.g * 255.0 + 0.5);

  vec2 centre = (vec2(ci) + 0.5) * cell;
  float clear = 1.0;
  for (int i = 0; i < ${MAX_CLEAR}; i++) {
    if (i >= clearCount) break;
    vec4 r = clearRects[i];
    vec2 d = max(max(r.xy - centre, centre - r.zw), 0.0);
    clear *= smoothstep(0.0, ${FEATHER.toFixed(1)}, length(d));
  }

  // The simulation runs bottom-up, like GL.
  vec2 sc = vec2(centre.x, view.y - centre.y) / ${CELL.toFixed(1)};
  float now = texture(cur, sc / simSize).r;
  float before = texture(prev, (warp(sc - 0.5) + 0.5) / simSize).r;
  // Rising: flip to a stand-in, further along the faster it rises. Strong: full ink.
  float k = mod(floor(clamp((now - before - 0.01) / 0.99 * 5.0, 0.0, 1.0) * 5.654), 8.0);
  float lit = smoothstep(0.3, 0.8, now);
  float shown = k > 0.0 ? standBase + mod(seed + k * 5.0, standCount) : g;
  float level = mix(rest, 1.0, max(lit, k > 0.0 ? 0.7 : 0.0)) * clear;
  o = vec4(shown / 255.0, level, k > 0.0 ? 1.0 : 0.0, 1.0);
}`;

/** Draws each letter from the glyph atlas; flipping letters get the red/cyan split. */
const TEXT = `#version 300 es
precision highp float;
uniform sampler2D letters, atlas;
uniform vec2 view;      // canvas size, CSS px
uniform float dpr;
uniform vec2 cell;      // letter cell, CSS px
uniform vec2 atlasGrid; // columns, rows of the glyph atlas
uniform vec3 ink;
out vec4 o;

float glyph(float g, vec2 lp) {
  if (lp.x < 0.0 || lp.x > 1.0) return 0.0;
  vec2 uv = (vec2(mod(g, atlasGrid.x), floor(g / atlasGrid.x)) + lp) / atlasGrid;
  return texture(atlas, uv).a;
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, view.y * dpr - gl_FragCoord.y) / dpr; // top-down CSS px
  vec2 ci = floor(px / cell);
  vec4 st = texelFetch(letters, ivec2(ci), 0);
  if (st.g <= 0.0) { o = vec4(0.0); return; }
  float shown = floor(st.r * 255.0 + 0.5);
  vec2 lp = (px - ci * cell) / cell;
  float c = glyph(shown, lp);
  vec3 col = ink * c;
  float a = c;
  if (st.b > 0.5) {
    float off = 1.5 / cell.x;
    float l = max(glyph(shown, lp + vec2(off, 0.0)) - c, 0.0);
    float r = max(glyph(shown, lp - vec2(off, 0.0)) - c, 0.0);
    col += vec3(${RED.join(", ")}) * l + vec3(${CYAN.join(", ")}) * r;
    a = min(1.0, c + l + r);
  }
  o = vec4(col, a) * st.g;
}`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram | null {
  const prog = gl.createProgram();
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn("letterflip shader:", gl.getShaderInfoLog(sh));
      return null;
    }
    gl.attachShader(prog, sh);
  }
  gl.bindAttribLocation(prog, 0, "p");
  gl.linkProgram(prog);
  return gl.getProgramParameter(prog, gl.LINK_STATUS) ? prog : null;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Starts the effect on `canvas`, which should cover its positioned parent. Returns a function that
 * stops it and frees the GPU, or null when the browser can't run it (the page then simply has no
 * field, which is also what phones, tablets and reduced-motion visitors get).
 */
export function letterflip(canvas: HTMLCanvasElement, opts: LetterflipOptions): (() => void) | null {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });
  if (!gl) return null;
  if (!gl.getExtension("EXT_color_buffer_float") && !gl.getExtension("EXT_color_buffer_half_float")) return null;
  const sim = compile(gl, VERT, SIM);
  const letters = compile(gl, VERT, LETTERS);
  const text = compile(gl, VERT, TEXT);
  if (!sim || !letters || !text) return null;

  const loc = (p: WebGLProgram, n: string) => gl.getUniformLocation(p, n);
  const U = {
    sim: Object.fromEntries(["prev", "size", "seg[0]", "radius[0]", "phase", "warpK"].map((n) => [n, loc(sim, n)])),
    letters: Object.fromEntries(
      ["cur", "prev", "state", "simSize", "view", "cell", "standBase", "standCount", "rest", "clearRects", "clearCount", "phase", "warpK"].map(
        (n) => [n, loc(letters, n)],
      ),
    ),
    text: Object.fromEntries(["letters", "atlas", "view", "dpr", "cell", "atlasGrid", "ink"].map((n) => [n, loc(text, n)])),
  };

  // One triangle that covers the whole target.
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const texture = (filter: number) => {
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const targets = [0, 1].map(() => ({ tex: texture(gl.LINEAR), fbo: gl.createFramebuffer()! }));
  const stateTex = texture(gl.NEAREST);
  const lettersTarget = { tex: texture(gl.NEAREST), fbo: gl.createFramebuffer()! };
  let gridCols = 1, gridRows = 1;
  const atlasTex = texture(gl.LINEAR);

  // Glyphs: index 0 is "no letter"; the field's own letters, then the stand-ins in one run.
  const chars = [" "];
  const index = new Map<string, number>([[" ", 0]]);
  for (const ch of opts.text + STANDINS) if (!index.has(ch)) index.set(ch, chars.push(ch) - 1);
  const standBase = chars.length;
  for (const ch of STANDINS) chars.push(ch);
  const atlasCols = 16;
  const atlasRows = Math.ceil(chars.length / atlasCols);

  const phase = [Math.random() * 6.283, Math.random() * 6.283];
  let w = 0, h = 0, dpr = 1, cellW = 8, simW = 0, simH = 0;
  let cur = 0; // index of the newest simulation target
  let clearRects = new Float32Array(MAX_CLEAR * 4);
  let clearCount = 0;
  let ink = [1, 1, 1];
  let rest = 0.1;
  let rect = canvas.getBoundingClientRect();
  let ready = false;
  let stopped = false;

  const readTheme = () => {
    const m = getComputedStyle(canvas).color.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255];
    ink = m.slice(0, 3).map((v) => v / 255);
    const dark = (ink[0] + ink[1] + ink[2]) / 3 > 0.5;
    rest = dark ? 0.085 : 0.075;
  };

  const buildAtlas = () => {
    const family = getComputedStyle(document.documentElement).getPropertyValue("--font-geist-mono").trim() || "monospace";
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d")!;
    ctx.font = `${FONT_PX}px ${family}`;
    cellW = Math.max(6, Math.round(ctx.measureText("0").width));
    c.width = Math.round(cellW * dpr) * atlasCols;
    c.height = Math.round(LINE * dpr) * atlasRows;
    const cw = c.width / atlasCols, ch = c.height / atlasRows;
    ctx.font = `${FONT_PX * dpr}px ${family}`;
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    chars.forEach((g, i) => ctx.fillText(g, (i % atlasCols) * cw + cw / 2, Math.floor(i / atlasCols) * ch + ch / 2));
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  };

  /** Fills the grid with the text, each row starting at a different place so it never looks tiled. */
  const buildField = () => {
    const cols = (gridCols = Math.ceil(w / cellW) + 1), rows = (gridRows = Math.ceil(h / LINE) + 1);
    const src = opts.text;
    const data = new Uint8Array(cols * rows * 4);
    for (let r = 0; r < rows; r++) {
      const start = (r * r * 7 + r * 13) % src.length;
      for (let c = 0; c < cols; c++) {
        const i = (r * cols + c) * 4;
        data[i] = index.get(src[(start + c) % src.length]) ?? 0;
        data[i + 1] = ((r * cols + c) * 7919) % 251;
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, stateTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindTexture(gl.TEXTURE_2D, lettersTarget.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, lettersTarget.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, lettersTarget.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  const clearSim = () => {
    for (const t of targets) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  const measureClear = () => {
    rect = canvas.getBoundingClientRect();
    const parent = canvas.parentElement;
    const els = opts.clearSelector && parent ? Array.from(parent.querySelectorAll(opts.clearSelector)).slice(0, MAX_CLEAR) : [];
    clearRects = new Float32Array(MAX_CLEAR * 4);
    clearCount = 0;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      clearRects.set([r.left - rect.left, r.top - rect.top, r.right - rect.left, r.bottom - rect.top], clearCount++ * 4);
    }
  };

  const resize = () => {
    w = Math.max(1, canvas.clientWidth);
    h = Math.max(1, canvas.clientHeight);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    simW = Math.ceil(w / CELL);
    simH = Math.ceil(h / CELL);
    for (const t of targets) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, simW, simH, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    }
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) return false;
    clearSim();
    readTheme();
    buildAtlas();
    buildField();
    measureClear();
    return true;
  };

  const setWarp = (u: Record<string, WebGLUniformLocation | null>) => {
    gl.uniform2f(u.phase, phase[0], phase[1]);
    gl.uniform1f(u.warpK, CELL / window.innerHeight);
  };

  /** One simulation step with up to two strokes: [ax, ay, bx, by] in cells (bottom-up) and radii in cells. */
  const step = (segs: number[], radii: number[]) => {
    const from = targets[cur], to = targets[1 - cur];
    gl.useProgram(sim);
    gl.bindFramebuffer(gl.FRAMEBUFFER, to.fbo);
    gl.viewport(0, 0, simW, simH);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, from.tex);
    gl.uniform1i(U.sim.prev, 0);
    gl.uniform2f(U.sim.size, simW, simH);
    gl.uniform4fv(U.sim["seg[0]"], new Float32Array([...segs, 0, 0, 0, 0, 0, 0, 0, 0].slice(0, 8)));
    gl.uniform1fv(U.sim["radius[0]"], new Float32Array([...radii, 0, 0].slice(0, 2)));
    setWarp(U.sim);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    cur = 1 - cur;
  };

  const bind = (unit: number, tex: WebGLTexture, at: WebGLUniformLocation | null) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(at, unit);
  };

  const draw = () => {
    // 1. Each letter's state, one texel per letter.
    const L = U.letters;
    gl.useProgram(letters);
    gl.bindFramebuffer(gl.FRAMEBUFFER, lettersTarget.fbo);
    gl.viewport(0, 0, gridCols, gridRows);
    bind(0, targets[cur].tex, L.cur);
    bind(1, targets[1 - cur].tex, L.prev);
    bind(2, stateTex, L.state);
    gl.uniform2f(L.simSize, simW, simH);
    gl.uniform2f(L.view, w, h);
    gl.uniform2f(L.cell, cellW, LINE);
    gl.uniform1f(L.standBase, standBase);
    gl.uniform1f(L.standCount, STANDINS.length);
    gl.uniform1f(L.rest, rest);
    gl.uniform4fv(L.clearRects, clearRects);
    gl.uniform1i(L.clearCount, clearCount);
    setWarp(L);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2. The letters themselves, from the atlas.
    const T = U.text;
    gl.useProgram(text);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    bind(0, lettersTarget.tex, T.letters);
    bind(1, atlasTex, T.atlas);
    gl.uniform2f(T.view, w, h);
    gl.uniform1f(T.dpr, canvas.width / w);
    gl.uniform2f(T.cell, cellW, LINE);
    gl.uniform2f(T.atlasGrid, atlasCols, atlasRows);
    gl.uniform3f(T.ink, ink[0], ink[1], ink[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  // Mouse and loop.
  let mouse = { x: 0, y: 0 }, last = { x: 0, y: 0 };
  let fresh = true, lastMove = 0, lastStep = 0, lastPaint = 0, target = 0, speed = 0;
  let raf = 0;
  let painted = false; // whether the grid holds anything since it was last cleared

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    if (now - lastStep < 15) return; // the same speed on 120 Hz screens
    lastStep = now;
    let d = Math.hypot((mouse.x - last.x) / innerWidth, (mouse.y - last.y) / innerHeight);
    if (fresh || d > 0.3) {
      fresh = false;
      last = { ...mouse };
      target = 0;
      d = 0;
    }
    target = clamp01((target + d * 6) * 0.88);
    speed += (1 - Math.pow(1 - target, 4) - speed) * 0.1;
    const t = clamp01((speed - 0.1) / 0.9);
    const radius = (0.05 * t * t * (3 - 2 * t) * innerHeight) / CELL;
    // Grid cells, bottom-up.
    step([last.x / CELL, (h - last.y) / CELL, mouse.x / CELL, (h - mouse.y) / CELL], [radius]);
    last = { ...mouse };
    if (radius > 0) {
      lastPaint = now;
      painted = true;
    }
    draw();
    // A full-strength cell falls below visibility in about 200 steps (3 s); then rest.
    if ((!painted || now - lastPaint > 3500) && speed < 0.01) {
      cancelAnimationFrame(raf);
      raf = 0;
      painted = false;
      clearSim();
      draw();
      canvas.dataset.ripple = "ready";
    }
  };

  // Ambient: two unseen wanderers drift on slow, never-repeating paths and paint in bursts, so rings
  // keep rising and fading across the field. About 30 steps a second, which also halves the work.
  const ambient = opts.mode === "ambient";
  const wanderers = [0, 1].map(() => ({
    f: [0.09 + Math.random() * 0.08, 0.07 + Math.random() * 0.08],
    p: [Math.random() * 6.283, Math.random() * 6.283, Math.random() * 6.283],
    last: null as null | { x: number; y: number },
  }));
  let t0 = 0;
  let visible = true;
  let slow = (() => {
    try {
      return sessionStorage.getItem(SLOW_KEY) === "1";
    } catch {
      return false;
    }
  })();
  // A device that can't keep up (no real GPU, or a struggling one) gets a still field instead of
  // a page that stutters: if frames arrive slower than about 22 a second while drifting, stop, and
  // remember it for the rest of the visit.
  let lastFrame = 0, gapAvg = 16, frames = 0;
  const drift = (now: number) => {
    raf = requestAnimationFrame(drift);
    if (lastFrame) {
      gapAvg += (Math.min(now - lastFrame, 500) - gapAvg) * 0.1;
      if (++frames > 10 && gapAvg > 45) {
        try {
          sessionStorage.setItem(SLOW_KEY, "1");
        } catch {}
        pauseDrift();
        canvas.dataset.ripple = "still";
        slow = true;
        return;
      }
    }
    lastFrame = now;
    if (now - lastStep < 33) return;
    lastStep = now;
    const t = (now - t0) / 1000;
    const segs: number[] = [], radii: number[] = [];
    for (const [i, wd] of wanderers.entries()) {
      const pos = {
        x: w * (0.5 + 0.45 * Math.sin(t * wd.f[0] + wd.p[0]) * Math.cos(t * 0.031 + i)),
        y: h * (0.5 + 0.45 * Math.sin(t * wd.f[1] + wd.p[1])),
      };
      const from = wd.last ?? pos;
      wd.last = pos;
      // Bursts: the brush swells and vanishes every few seconds, so each burst leaves a ring.
      const pulse = Math.max(0, Math.sin(t * (0.55 + i * 0.17) + wd.p[2]));
      const r = (0.035 * Math.min(innerHeight, 900) * pulse * pulse) / CELL;
      segs.push(from.x / CELL, (h - from.y) / CELL, pos.x / CELL, (h - pos.y) / CELL);
      radii.push(r > 0.6 ? r : 0);
    }
    step(segs, radii);
    draw();
  };
  const startDrift = () => {
    if (raf || stopped || !ready || !visible) return;
    if (slow) {
      canvas.dataset.ripple = "still";
      return;
    }
    lastFrame = 0;
    frames = 0;
    canvas.dataset.drifted = "1";
    if (!t0) t0 = performance.now();
    canvas.dataset.ripple = "drifting";
    raf = requestAnimationFrame(drift);
  };
  const pauseDrift = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    for (const wd of wanderers) wd.last = null;
    if (ready) canvas.dataset.ripple = "ready";
  };
  // Only while the field is on screen: no work behind a scrolled-away page.
  const io = new IntersectionObserver(([e]) => {
    visible = !!e?.isIntersecting;
    if (!ambient) return;
    if (visible) startDrift();
    else pauseDrift();
  });
  io.observe(canvas);

  const start = () => {
    if (ambient || raf || stopped || !ready) return;
    lastPaint = performance.now();
    canvas.dataset.ripple = "moving";
    raf = requestAnimationFrame(frame);
  };

  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (x < -MARGIN || y < -MARGIN || x > w + MARGIN || y > h + MARGIN) {
      fresh = true;
      return;
    }
    const now = performance.now();
    if (now - lastMove > 150) fresh = true; // a pause starts a new stroke
    lastMove = now;
    mouse = { x, y };
    start();
  };
  const onScroll = () => {
    fresh = true; // the page moved under a still mouse: no long jump line
    measureClear();
    if (ready && !raf) draw();
  };

  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (stopped) return;
      if (resize()) draw();
    }, 150);
  };
  const ro = new ResizeObserver(onResize);
  ro.observe(canvas);
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  const onScheme = () => {
    readTheme();
    if (ready && !raf) draw();
  };
  const onLost = (e: Event) => {
    e.preventDefault();
    stop();
    canvas.dataset.ripple = "lost";
  };

  window.addEventListener("pointermove", onMove, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });
  scheme.addEventListener("change", onScheme);
  canvas.addEventListener("webglcontextlost", onLost);

  // Measure once the monospace font has arrived, or the letter widths are wrong.
  const family = getComputedStyle(document.documentElement).getPropertyValue("--font-geist-mono").trim() || "monospace";
  Promise.resolve(document.fonts?.load(`${FONT_PX}px ${family}`))
    .catch(() => undefined)
    .then(() => {
      if (stopped) return;
      if (!resize()) return;
      if (opts.clearSelector && canvas.parentElement) {
        for (const el of canvas.parentElement.querySelectorAll(opts.clearSelector)) ro.observe(el);
      }
      draw();
      ready = true;
      canvas.dataset.ripple = "ready";
      if (ambient) startDrift();
    });

  function stop() {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    clearTimeout(resizeTimer);
    ro.disconnect();
    io.disconnect();
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("scroll", onScroll, { capture: true });
    scheme.removeEventListener("change", onScheme);
    canvas.removeEventListener("webglcontextlost", onLost);
  }
  return () => {
    stop();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  };
}
