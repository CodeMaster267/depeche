import { describe, expect, it } from "vitest";
import { detectCorners, enhance, findPage, homography, insetQuad, isConvex, outputSize, project, rotate90, warp, type Pixels, type Quad } from "@/lib/scan/image";
import { pdfFileName, scanName, scansToPdf } from "@/lib/scan/pdf";

/** A dark table with a light, slightly tilted page on it. */
function photo(width: number, height: number, page: Quad, paper = 230, table = 60): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  const inside = (x: number, y: number) => {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = page[i];
      const b = page[(i + 1) % 4];
      const s = Math.sign((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x));
      if (s && sign && s !== sign) return false;
      if (s) sign = s;
    }
    return true;
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const v = inside(x + 0.5, y + 0.5) ? paper : table;
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  return { data, width, height };
}

const page: Quad = [
  { x: 90, y: 60 },
  { x: 500, y: 90 },
  { x: 470, y: 640 },
  { x: 70, y: 610 },
];

describe("finding the page", () => {
  it("finds the corners of a light page on a dark table", () => {
    const { quad, found } = findPage(photo(600, 700, page));
    expect(found).toBe(true);
    quad.forEach((p, i) => {
      expect(Math.abs(p.x - page[i].x)).toBeLessThan(12);
      expect(Math.abs(p.y - page[i].y)).toBeLessThan(12);
    });
  });

  it("falls back to the whole photo when there's no page to find", () => {
    const flat = photo(300, 400, insetQuad(300, 400, 0), 200, 200);
    const { quad, found } = findPage(flat);
    expect(found).toBe(false);
    expect(quad).toEqual(insetQuad(300, 400));
  });

  it("ignores a light patch too small to be a page", () => {
    const gray = new Uint8Array(100 * 100).fill(30);
    for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) gray[y * 100 + x] = 240;
    expect(detectCorners(gray, 100, 100)).toBeNull();
  });

  it("knows a twisted shape isn't a page", () => {
    expect(isConvex(page)).toBe(true);
    expect(isConvex([page[0], page[2], page[1], page[3]])).toBe(false);
  });
});

describe("straightening", () => {
  it("maps the output's corners onto the page's corners", () => {
    const H = homography(page, 400, 560);
    const corners = [project(H, 0, 0), project(H, 400, 0), project(H, 400, 560), project(H, 0, 560)];
    corners.forEach((p, i) => {
      expect(p.x).toBeCloseTo(page[i].x, 6);
      expect(p.y).toBeCloseTo(page[i].y, 6);
    });
  });

  it("comes out at the page's own size, within the limit", () => {
    const { width, height } = outputSize(page, 10_000);
    expect(width).toBeGreaterThan(400);
    expect(height).toBeGreaterThan(540);
    const small = outputSize(page, 300);
    expect(Math.max(small.width, small.height)).toBe(300);
  });

  it("leaves only paper once the page is cut out", () => {
    const px = photo(600, 700, page);
    const { quad } = findPage(px);
    const out = warp(px, quad, 200, 280);
    let dark = 0;
    for (let i = 0; i < out.data.length; i += 4) if (out.data[i] < 150) dark++;
    // A sliver of table at the very edge at most.
    expect(dark / (200 * 280)).toBeLessThan(0.03);
  });

  it("turns a picture a quarter turn", () => {
    const px: Pixels = { data: new Uint8ClampedArray([1, 0, 0, 255, 2, 0, 0, 255]), width: 2, height: 1 };
    const r = rotate90(px);
    expect([r.width, r.height]).toEqual([1, 2]);
    expect([r.data[0], r.data[4]]).toEqual([1, 2]);
  });
});

describe("cleaning up", () => {
  /** Grey paper in a shadow on one side, with a line of dark text. */
  function shadowed(): Pixels {
    const w = 200;
    const h = 200;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const paper = 120 + (x / w) * 80; // 120 in the shadow, 200 in the light
        const ink = y >= 95 && y < 105 && x % 20 < 10;
        const v = ink ? paper * 0.3 : paper;
        const i = (y * w + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
    return { data, width: w, height: h };
  }
  const at = (px: Pixels, x: number, y: number) => px.data[(y * px.width + x) * 4];

  it("makes shadowed and lit paper both white, and keeps text dark", () => {
    for (const look of ["clean", "bw"] as const) {
      const px = enhance(shadowed(), look);
      expect(at(px, 5, 20)).toBeGreaterThan(235);
      expect(at(px, 195, 20)).toBeGreaterThan(235);
      expect(at(px, 5, 100)).toBeLessThan(80);
      expect(at(px, 185, 100)).toBeLessThan(80);
    }
  });

  it("changes nothing for the original look", () => {
    const before = shadowed();
    const copy = new Uint8ClampedArray(before.data);
    expect(enhance(before, "original").data).toEqual(copy);
  });
});

describe("the PDF", () => {
  // A 1×1 white JPEG.
  const JPEG = Uint8Array.from(
    atob(
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
    ),
    (c) => c.charCodeAt(0),
  );

  it("has one page per scan, shaped like the scan", async () => {
    const blob = await scansToPdf(
      [
        { jpeg: JPEG, width: 1000, height: 1414 },
        { jpeg: JPEG, width: 1414, height: 1000 },
      ],
      "Receipts",
    );
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(new Uint8Array(await blob.arrayBuffer()));
    expect(doc.getPageCount()).toBe(2);
    const [a, b] = doc.getPages().map((p) => p.getSize());
    expect(a.width).toBeCloseTo(595.28, 1);
    expect(a.height).toBeCloseTo(841.7, 0);
    expect(b.width).toBeCloseTo(841.89, 1);
    expect(doc.getTitle()).toBe("Receipts");
  });

  it("names files safely", () => {
    expect(pdfFileName("Tax / 2026")).toBe("Tax - 2026.pdf");
    expect(pdfFileName("notes.pdf")).toBe("notes.pdf");
    expect(pdfFileName("  ")).toMatch(/^Scan .+\.pdf$/);
    expect(scanName(new Date(2026, 10, 4, 9, 5))).toBe("Scan 4 Nov 2026 09.05");
  });
});
