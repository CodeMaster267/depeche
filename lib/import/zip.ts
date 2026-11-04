/**
 * Reads single files out of a zip without loading the whole zip into memory. Export zips can be
 * gigabytes (ChatGPT's includes every image), which an iPhone can't hold, but the chats are one
 * small file inside: read the zip's table of contents from its end, then just that file.
 */
import { inflateSync } from "fflate";

export type ZipEntry = { name: string; method: number; compressedSize: number; size: number; offset: number };

/** Anything with Blob's slice: a File from the picker, or a Blob in tests. */
type Source = Pick<Blob, "size" | "slice">;

async function read(src: Source, start: number, end: number): Promise<DataView> {
  const buf = await src.slice(start, end).arrayBuffer();
  return new DataView(buf);
}

const u64 = (v: DataView, at: number) => Number(v.getBigUint64(at, true));

export async function listZip(src: Source): Promise<ZipEntry[]> {
  // The end-of-central-directory record is in the last 22 bytes plus up to 64 KB of comment.
  const tailStart = Math.max(0, src.size - 65_557);
  const tail = await read(src, tailStart, src.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip");
  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);
  // Zip64 (zips over 4 GB, or with very many files) keeps the real numbers in another record.
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || tail.getUint32(loc, true) !== 0x07064b50) throw new Error("bad zip64");
    const z = await read(src, u64(tail, loc + 8), u64(tail, loc + 8) + 56);
    if (z.getUint32(0, true) !== 0x06064b50) throw new Error("bad zip64");
    count = u64(z, 32);
    cdSize = u64(z, 40);
    cdOffset = u64(z, 48);
  }
  const cd = await read(src, cdOffset, cdOffset + cdSize);
  const names = new TextDecoder();
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const method = cd.getUint16(p + 10, true);
    let compressedSize = cd.getUint32(p + 20, true);
    let size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    let offset = cd.getUint32(p + 42, true);
    const name = names.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    // Zip64 sizes and offset live in an "extra" field, in this order, only for those that overflowed.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = cd.getUint16(e, true);
      const len = cd.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) (size = u64(cd, q)), (q += 8);
        if (compressedSize === 0xffffffff) (compressedSize = u64(cd, q)), (q += 8);
        if (offset === 0xffffffff) offset = u64(cd, q);
      }
      e += 4 + len;
    }
    entries.push({ name, method, compressedSize, size, offset });
    p = extraEnd + commentLen;
  }
  return entries;
}

/** One file's contents. */
export async function readZipEntry(src: Source, entry: ZipEntry): Promise<Uint8Array> {
  const head = await read(src, entry.offset, entry.offset + 30);
  if (head.getUint32(0, true) !== 0x04034b50) throw new Error("bad zip entry");
  const start = entry.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
  const raw = new Uint8Array(await src.slice(start, start + entry.compressedSize).arrayBuffer());
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateSync(raw, entry.size ? { out: new Uint8Array(entry.size) } : undefined);
  throw new Error("unsupported zip compression");
}
