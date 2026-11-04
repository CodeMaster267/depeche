"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { LOOKS, enhance, findPage, outputSize, rotate90, warp, type Look, type Pixels, type Quad } from "@/lib/scan/image";
import { MAX_SCAN_PAGES, pdfFileName, scanName, scansToPdf } from "@/lib/scan/pdf";
import { MAX_FILE_BYTES, sizeLabel } from "@/lib/chat/files";
import { CameraIcon, CloseIcon, PhotoIcon, PlusIcon, RotateIcon } from "./icons";

/**
 * Scanning pages with the camera into one PDF. Everything happens on the device: each photo is
 * straightened (drag the corners to adjust), cleaned up so the paper comes out white, and the
 * pages are put together into a PDF that is attached to the message or saved.
 */

/** Photos are kept at most this big while editing; pages come out at most PAGE_EDGE. */
const SOURCE_EDGE = 2400;
const PAGE_EDGE = 2000;

type Photo = { blob: Blob; url: string; width: number; height: number };
type Page = { id: string; photo: Photo; quad: Quad; look: Look; result: Blob; url: string; width: number; height: number };
type Draft = { photo: Photo; quad: Quad; look: Look; tab: "crop" | Look; index: number | null; preview?: string };

const CORNERS = ["Top left", "Top right", "Bottom right", "Bottom left"];

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

function canvas(width: number, height: number) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

const toBlob = (c: HTMLCanvasElement, quality: number) =>
  new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't save the page."))), "image/jpeg", quality));

async function decode(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A photo, the right way up and no bigger than needed, as a JPEG kept for editing. */
async function loadPhoto(file: Blob): Promise<Photo> {
  const img = await decode(file);
  const scale = Math.min(1, SOURCE_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const c = canvas(Math.round(img.naturalWidth * scale), Math.round(img.naturalHeight * scale));
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const blob = await toBlob(c, 0.92);
  return { blob, url: URL.createObjectURL(blob), width: c.width, height: c.height };
}

async function pixelsOf(photo: Photo): Promise<Pixels> {
  const img = await decode(photo.blob);
  const c = canvas(photo.width, photo.height);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { data: d.data, width: d.width, height: d.height };
}

function pixelsToCanvas(px: Pixels) {
  const c = canvas(px.width, px.height);
  const image = new ImageData(px.width, px.height);
  image.data.set(px.data);
  c.getContext("2d")!.putImageData(image, 0, 0);
  return c;
}

/** The finished page: straightened, cleaned up and saved as a JPEG. */
async function renderPage(photo: Photo, quad: Quad, look: Look, edge = PAGE_EDGE, quality = 0.8) {
  const px = await pixelsOf(photo);
  const { width, height } = outputSize(quad, edge);
  const out = enhance(warp(px, quad, width, height), look);
  const blob = await toBlob(pixelsToCanvas(out), quality);
  return { blob, width, height };
}

async function rotatePhoto(photo: Photo): Promise<Photo> {
  const c = pixelsToCanvas(rotate90(await pixelsOf(photo)));
  const blob = await toBlob(c, 0.92);
  return { blob, url: URL.createObjectURL(blob), width: c.width, height: c.height };
}

async function detect(photo: Photo): Promise<Quad> {
  return findPage(await pixelsOf(photo)).quad;
}

/** Phones and tablets get the share sheet (Save to Files, AirDrop, Mail); computers download. */
async function saveFile(file: File) {
  if (matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export default function ScanSheet({ initial, onAttach, onClose }: { initial: File[]; onAttach: (file: File) => void; onClose: () => void }) {
  const [pages, setPages] = useState<Page[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState(() => scanName());
  const [pdf, setPdf] = useState<File | null>(null);
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  const urls = useRef(new Set<string>());
  const track = (url: string) => (urls.current.add(url), url);

  useEffect(() => {
    const all = urls.current;
    return () => all.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const work = useCallback(async <T,>(label: string, job: () => Promise<T>): Promise<T | undefined> => {
    setBusy(label);
    setProblem(null);
    await nextFrame(); // let "Working…" show before the heavy lifting
    try {
      return await job();
    } catch {
      setProblem("That photo couldn't be read. Try another.");
      return undefined;
    } finally {
      setBusy(null);
    }
  }, []);

  /** New photos: one opens for cropping; several go straight in as pages, each cropped by itself. */
  const addPhotos = useCallback(
    async (files: File[]) => {
      const images = files.filter((f) => f.type.startsWith("image/") || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name));
      if (!images.length) return;
      const room = MAX_SCAN_PAGES - pages.length;
      if (room <= 0) return setProblem(`A scan can have up to ${MAX_SCAN_PAGES} pages.`);
      const picked = images.slice(0, room);
      if (picked.length === 1) {
        await work("Finding the page…", async () => {
          const photo = await loadPhoto(picked[0]);
          track(photo.url);
          setDraft({ photo, quad: await detect(photo), look: "clean", tab: "crop", index: null });
        });
        return;
      }
      await work(`Scanning ${picked.length} pages…`, async () => {
        const made: Page[] = [];
        for (const file of picked) {
          const photo = await loadPhoto(file);
          track(photo.url);
          const quad = await detect(photo);
          const r = await renderPage(photo, quad, "clean");
          made.push({ id: crypto.randomUUID(), photo, quad, look: "clean", result: r.blob, url: track(URL.createObjectURL(r.blob)), width: r.width, height: r.height });
        }
        setPages((list) => [...list, ...made]);
      });
      if (images.length > room) setProblem(`A scan can have up to ${MAX_SCAN_PAGES} pages.`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pages.length, work],
  );

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (initial.length) void addPhotos(initial);
  }, [initial, addPhotos]);

  // The PDF is made as soon as the pages change, so Save can open the share sheet straight from
  // the tap (iPhone only allows that directly after one).
  useEffect(() => {
    setPdf(null);
    if (!pages.length) return;
    let gone = false;
    const t = setTimeout(async () => {
      try {
        const file = await buildPdf(pages, name);
        if (!gone) setPdf(file);
      } catch {
        if (!gone) setProblem("Couldn't make the PDF. Try again.");
      }
    }, 300);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [pages, name]);

  // A look's preview while editing.
  useEffect(() => {
    if (!draft || draft.tab === "crop" || draft.preview) return;
    let gone = false;
    const { photo, quad, tab } = draft;
    void work("Cleaning up…", async () => {
      const r = await renderPage(photo, quad, tab, 1400, 0.8);
      if (gone) return;
      const url = track(URL.createObjectURL(r.blob));
      setDraft((d) => (d && d.photo === photo && d.quad === quad && d.tab === tab ? { ...d, preview: url } : d));
    });
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.tab, draft?.quad, draft?.photo, draft?.preview]);

  async function keepDraft() {
    if (!draft) return;
    const d = draft;
    await work("Saving the page…", async () => {
      const r = await renderPage(d.photo, d.quad, d.look);
      const page: Page = { id: crypto.randomUUID(), photo: d.photo, quad: d.quad, look: d.look, result: r.blob, url: track(URL.createObjectURL(r.blob)), width: r.width, height: r.height };
      setPages((list) => (d.index === null ? [...list, page] : list.map((p, i) => (i === d.index ? page : p))));
      setDraft(null);
    });
  }

  function move(index: number, by: number) {
    setPages((list) => {
      const to = index + by;
      if (to < 0 || to >= list.length) return list;
      const next = [...list];
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });
    setDraft((d) => (d && d.index !== null ? { ...d, index: d.index + by } : d));
  }

  function close() {
    if (pages.length && !window.confirm(`Discard ${pages.length === 1 ? "this scanned page" : `these ${pages.length} scanned pages`}?`)) return;
    onClose();
  }

  async function attach() {
    const file = pdf ?? (await work("Making the PDF…", () => buildPdf(pages, name)));
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) return setProblem(`This PDF is ${sizeLabel(file.size)}; attachments can be up to 10 MB. Save it instead, or remove some pages.`);
    onAttach(file);
    onClose();
  }

  async function save() {
    const file = pdf ?? (await work("Making the PDF…", () => buildPdf(pages, name)));
    if (file) await saveFile(file);
  }

  const inputs = (
    <>
      <input
        ref={camera}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        data-testid="scan-camera"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          void addPhotos(files);
        }}
      />
      <input
        ref={library}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        data-testid="scan-photos"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          void addPhotos(files);
        }}
      />
    </>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={draft ? (draft.index === null ? "New page" : `Page ${draft.index + 1}`) : "Scan pages"}
      className="fixed inset-0 z-50 flex flex-col bg-bg text-fg"
      style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      {inputs}
      {draft ? (
        <Editor
          draft={draft}
          count={pages.length}
          busy={busy}
          onChange={(d) => setDraft(d)}
          onCancel={() => setDraft(null)}
          onKeep={keepDraft}
          onRotate={() =>
            work("Turning…", async () => {
              const photo = await rotatePhoto(draft.photo);
              track(photo.url);
              setDraft({ ...draft, photo, quad: await detect(photo), preview: undefined });
            })
          }
          onDelete={
            draft.index === null
              ? undefined
              : () => {
                  const at = draft.index!;
                  setPages((list) => list.filter((_, i) => i !== at));
                  setDraft(null);
                }
          }
          onMove={draft.index === null ? undefined : (by) => move(draft.index!, by)}
        />
      ) : (
        <>
          <header className="flex h-14 shrink-0 items-center justify-between gap-2 px-2">
            <button type="button" onClick={close} className="press flex h-11 w-11 items-center justify-center rounded-full" aria-label="Close scanner">
              <CloseIcon />
            </button>
            <h2 className="text-[17px] font-semibold">{pages.length ? `${pages.length} ${pages.length === 1 ? "page" : "pages"}` : "Scan pages"}</h2>
            <span className="w-11" />
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4">
            {pages.length ? (
              <ol className="mx-auto grid max-w-[760px] grid-cols-2 gap-3 py-2 sm:grid-cols-3 md:grid-cols-4" aria-label="Scanned pages">
                {pages.map((p, i) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      data-testid="scan-page"
                      onClick={() => setDraft({ photo: p.photo, quad: p.quad, look: p.look, tab: p.look, index: i, preview: p.url })}
                      className="press relative block w-full overflow-hidden rounded-xl border border-line bg-soft"
                      style={{ aspectRatio: `${p.width} / ${p.height}` }}
                      aria-label={`Page ${i + 1}: edit`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.url} alt="" className="h-full w-full object-contain" />
                      <span className="absolute bottom-1.5 left-1.5 rounded-full bg-inv px-2 text-[12px] leading-5 text-on-inv">{i + 1}</span>
                    </button>
                  </li>
                ))}
                {pages.length < MAX_SCAN_PAGES ? (
                  <li>
                    <button
                      type="button"
                      onClick={() => camera.current?.click()}
                      className="press flex aspect-[1/1.414] w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line text-mute hover:text-fg"
                    >
                      <PlusIcon />
                      <span className="text-[14px]">Add page</span>
                    </button>
                  </li>
                ) : null}
              </ol>
            ) : (
              <div className="mx-auto flex h-full max-w-[420px] flex-col items-center justify-center gap-6 text-center">
                <p className="text-[17px] leading-7 text-mute">
                  Take a photo of each page. Depeche finds the edges, straightens it and makes the paper white, then puts the pages into one PDF.
                </p>
                <div className="flex w-full flex-col gap-2">
                  <button type="button" onClick={() => camera.current?.click()} disabled={!!busy} className="press glass flex h-12 items-center justify-center gap-2 rounded-full text-[17px]">
                    <CameraIcon /> Take a photo
                  </button>
                  <button
                    type="button"
                    onClick={() => library.current?.click()}
                    disabled={!!busy}
                    className="press flex h-12 items-center justify-center gap-2 rounded-full border border-line text-[17px]"
                  >
                    <PhotoIcon /> Choose photos
                  </button>
                </div>
              </div>
            )}
          </div>

          {problem || busy ? (
            <p role={problem ? "alert" : "status"} className="mx-auto w-full max-w-[760px] px-4 pb-2 text-center text-[15px] text-mute">
              {busy ?? problem}
            </p>
          ) : null}

          {pages.length ? (
            <footer className="mx-auto flex w-full max-w-[760px] flex-col gap-2 px-4 pt-2">
              <label className="flex items-center gap-2 rounded-2xl border border-line px-4">
                <span className="text-[15px] text-mute">Name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-label="PDF name"
                  className="h-11 min-w-0 flex-1 bg-transparent text-[17px] outline-none"
                />
                <span className="text-[15px] text-faint">.pdf</span>
              </label>
              <div className="flex gap-2">
                <button type="button" onClick={() => library.current?.click()} disabled={!!busy} className="press flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-line" aria-label="Add photos">
                  <PhotoIcon />
                </button>
                <button type="button" onClick={save} disabled={!!busy} className="press h-12 flex-1 rounded-full border border-line text-[17px] disabled:opacity-40">
                  Save PDF
                </button>
                <button type="button" onClick={attach} disabled={!!busy} className="press glass h-12 flex-1 rounded-full text-[17px] disabled:opacity-40">
                  Attach
                </button>
              </div>
              {pdf ? <p className="text-center text-[13px] text-faint">{sizeLabel(pdf.size)}</p> : null}
            </footer>
          ) : null}
        </>
      )}
    </div>
  );
}

/** The pages as one PDF, made smaller if it would be over the 10 MB attachment limit. */
async function buildPdf(pages: Page[], name: string): Promise<File> {
  const title = pdfFileName(name).replace(/\.pdf$/, "");
  const parts = await Promise.all(pages.map(async (p) => ({ jpeg: new Uint8Array(await p.result.arrayBuffer()), width: p.width, height: p.height })));
  let blob = await scansToPdf(parts, title);
  if (blob.size > MAX_FILE_BYTES * 0.95) {
    const smaller = [];
    for (const p of pages) {
      const r = await renderPage(p.photo, p.quad, p.look, 1400, 0.6);
      smaller.push({ jpeg: new Uint8Array(await r.blob.arrayBuffer()), width: r.width, height: r.height });
    }
    blob = await scansToPdf(smaller, title);
  }
  return new File([blob], `${title}.pdf`, { type: "application/pdf" });
}

function Editor({
  draft,
  count,
  busy,
  onChange,
  onCancel,
  onKeep,
  onRotate,
  onDelete,
  onMove,
}: {
  draft: Draft;
  count: number;
  busy: string | null;
  onChange: (d: Draft) => void;
  onCancel: () => void;
  onKeep: () => void;
  onRotate: () => void;
  onDelete?: () => void;
  onMove?: (by: number) => void;
}) {
  const tabs: { id: Draft["tab"]; label: string }[] = [{ id: "crop", label: "Crop" }, ...LOOKS.map((l) => ({ id: l.id, label: l.id === "bw" ? "B&W" : l.label }))];
  return (
    <>
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 px-2">
        <button type="button" onClick={onCancel} className="press h-11 rounded-full px-4 text-[17px]">
          Cancel
        </button>
        <h2 className="text-[17px] font-semibold">{draft.index === null ? `Page ${count + 1}` : `Page ${draft.index + 1}`}</h2>
        <button type="button" onClick={onKeep} disabled={!!busy} className="press glass h-11 rounded-full px-5 text-[17px] disabled:opacity-40">
          {draft.index === null ? "Keep" : "Done"}
        </button>
      </header>

      <div className="relative min-h-0 flex-1 px-4 py-2">
        {draft.tab === "crop" ? (
          <CropView draft={draft} onQuad={(quad) => onChange({ ...draft, quad, preview: undefined })} />
        ) : draft.preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={draft.preview} alt={`Page preview, ${draft.tab === "bw" ? "black and white" : draft.tab}`} data-testid="scan-preview" className="h-full w-full object-contain" />
        ) : null}
        {busy ? (
          <p role="status" className="absolute inset-x-0 bottom-4 mx-auto w-fit rounded-full bg-inv px-4 py-1.5 text-[14px] text-on-inv">
            {busy}
          </p>
        ) : null}
      </div>

      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-2 px-4 pt-2">
        <div role="radiogroup" aria-label="Look" className="flex rounded-full border border-line p-1">
          {tabs.map((t) => {
            const on = draft.tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onChange({ ...draft, tab: t.id, look: t.id === "crop" ? draft.look : t.id, preview: t.id === draft.tab ? draft.preview : undefined })}
                className={`h-9 flex-1 rounded-full text-[15px] transition-colors ${on ? "bg-inv text-on-inv" : "text-mute"}`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-center gap-1">
          <button type="button" onClick={onRotate} disabled={!!busy} className="press flex h-11 items-center gap-1.5 rounded-full px-3 text-[15px] text-mute hover:text-fg">
            <RotateIcon /> Rotate
          </button>
          {onMove ? (
            <>
              <button type="button" onClick={() => onMove(-1)} disabled={draft.index === 0} className="press h-11 rounded-full px-3 text-[15px] text-mute hover:text-fg disabled:opacity-30">
                Move earlier
              </button>
              <button type="button" onClick={() => onMove(1)} disabled={draft.index === count - 1} className="press h-11 rounded-full px-3 text-[15px] text-mute hover:text-fg disabled:opacity-30">
                Move later
              </button>
            </>
          ) : null}
          {onDelete ? (
            <button type="button" onClick={onDelete} className="press h-11 rounded-full px-3 text-[15px] text-mute hover:text-fg">
              Delete
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}

/** The photo with the page's outline; each corner can be dragged, or moved with the arrow keys. */
function CropView({ draft, onQuad }: { draft: Draft; onQuad: (q: Quad) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const dragging = useRef<number | null>(null);
  const { photo, quad } = draft;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = size.w && size.h ? Math.min(size.w / photo.width, size.h / photo.height) : 0;
  const shown = { w: photo.width * scale, h: photo.height * scale };

  const at = (e: ReactPointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    return {
      x: Math.min(photo.width, Math.max(0, ((e.clientX - r.left) / r.width) * photo.width)),
      y: Math.min(photo.height, Math.max(0, ((e.clientY - r.top) / r.height) * photo.height)),
    };
  };
  const set = (i: number, p: { x: number; y: number }) => onQuad(quad.map((q, j) => (j === i ? p : q)) as Quad);

  const key = (i: number) => (e: KeyboardEvent) => {
    const step = Math.max(photo.width, photo.height) * (e.shiftKey ? 0.05 : 0.01);
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    const p = quad[i];
    set(i, { x: Math.min(photo.width, Math.max(0, p.x + d[0])), y: Math.min(photo.height, Math.max(0, p.y + d[1])) });
  };

  const handle = scale ? 12 / scale : 0;
  const reach = scale ? 26 / scale : 0;
  const line = scale ? 2 / scale : 0;
  const points = quad.map((p) => `${p.x},${p.y}`).join(" ");

  return (
    <div ref={box} className="flex h-full w-full items-center justify-center">
      {scale ? (
        <div className="relative" style={{ width: shown.w, height: shown.h }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photo.url} alt="Photo to crop" className="absolute inset-0 h-full w-full select-none" draggable={false} />
          <svg
            ref={svg}
            viewBox={`0 0 ${photo.width} ${photo.height}`}
            className="absolute inset-0 h-full w-full touch-none"
            data-testid="crop"
            onPointerMove={(e) => {
              if (dragging.current === null) return;
              e.preventDefault();
              set(dragging.current, at(e));
            }}
            onPointerUp={() => (dragging.current = null)}
            onPointerCancel={() => (dragging.current = null)}
          >
            <path
              d={`M0 0H${photo.width}V${photo.height}H0Z M${points.split(" ").join(" L")}Z`}
              fillRule="evenodd"
              fill="rgba(0,0,0,0.5)"
            />
            <polygon points={points} fill="none" stroke="#000" strokeOpacity={0.6} strokeWidth={line * 2.5} />
            <polygon points={points} fill="none" stroke="#fff" strokeWidth={line} />
            {quad.map((p, i) => (
              <g
                key={i}
                role="slider"
                tabIndex={0}
                aria-label={`${CORNERS[i]} corner`}
                aria-valuetext={`${Math.round((p.x / photo.width) * 100)}% across, ${Math.round((p.y / photo.height) * 100)}% down`}
                data-testid={`corner-${i}`}
                className="cursor-grab outline-none focus-visible:[&>circle:last-child]:stroke-[var(--fg)]"
                onKeyDown={key(i)}
                onPointerDown={(e) => {
                  e.preventDefault();
                  dragging.current = i;
                  svg.current?.setPointerCapture(e.pointerId);
                }}
              >
                <circle cx={p.x} cy={p.y} r={reach} fill="transparent" />
                <circle cx={p.x} cy={p.y} r={handle} fill="#fff" stroke="#000" strokeWidth={line} />
              </g>
            ))}
          </svg>
        </div>
      ) : null}
    </div>
  );
}
