"use client";

import { useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import {
  IMAGE_TYPES,
  MAX_FILE_BYTES,
  MAX_FILES_PER_MESSAGE,
  UPLOAD_BUCKET,
  refusal,
  sizeLabel,
  storedType,
  type FileRef,
} from "@/lib/chat/files";
import { CloseIcon, FileIcon } from "./icons";

export type Pending = {
  id: string;
  name: string;
  mime: string;
  size: number;
  preview?: string;
  status: "uploading" | "ready" | "error";
  error?: string;
  ref?: FileRef;
};

/** What the file picker offers. Other kinds can't be sent to a model. */
export const ACCEPT =
  "image/*,application/pdf,.pdf,text/*,.docx,.xlsx,.pptx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,.md,.csv,.tsv,.json,.jsonl,.xml,.yaml,.yml,.toml,.log,.html,.css,.js,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.kt,.swift,.c,.h,.cpp,.cs,.php,.sh,.sql,.tex";

const LONG_EDGE = 2048;

/**
 * Photos are resized to at most 2048px on the long edge and sent as JPEG, which keeps uploads
 * quick on a phone and the model's cost down. Other image formats (like iPhone HEIC) are converted
 * the same way. Small JPEG, PNG, WebP and GIF files are sent as they are.
 */
async function prepareImage(file: File): Promise<Blob> {
  if (IMAGE_TYPES.includes(file.type) && (file.type === "image/gif" || file.size <= 1.5 * 1024 * 1024)) return file;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, LONG_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.fillStyle = "#fff"; // transparent areas become white rather than black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
    return blob ?? file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const safeName = (name: string) => name.normalize("NFKD").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(-80) || "file";

/** Files picked for the next message: each uploads straight to your own private folder. */
export function useAttachments(userId: string) {
  const [items, setItems] = useState<Pending[]>([]);
  const live = useRef(items);
  live.current = items;

  const patch = (id: string, p: Partial<Pending>) => setItems((list) => list.map((x) => (x.id === id ? { ...x, ...p } : x)));

  async function add(files: File[]) {
    const room = MAX_FILES_PER_MESSAGE - live.current.length;
    const picked = files.slice(0, Math.max(0, room));
    const skipped = files.length - picked.length;
    const entries: { item: Pending; file: File; type: string | null }[] = picked.map((file) => {
      const type = storedType(file);
      return {
        file,
        type,
        item: {
          id: crypto.randomUUID(),
          name: file.name || "Pasted image",
          mime: type ?? file.type,
          size: file.size,
          preview: type?.startsWith("image/") ? URL.createObjectURL(file) : undefined,
          status: type ? "uploading" : "error",
          error: type ? undefined : refusal(file),
        },
      };
    });
    setItems((list) => [...list, ...entries.map((e) => e.item)]);
    await Promise.all(
      entries.map(async ({ item, file, type }) => {
        if (!type) return;
        try {
          const prepared = type.startsWith("image/") ? await prepareImage(file) : file;
          // Stored under the type Depeche reads it as (a .md file becomes plain text, say).
          const blob = prepared.type === type ? prepared : new Blob([prepared], { type });
          if (blob.size > MAX_FILE_BYTES) {
            patch(item.id, { status: "error", error: "Over 10 MB" });
            return;
          }
          let name = item.name;
          if (type === "image/jpeg" && prepared !== file) name = name.replace(/\.\w+$/, "") + ".jpg";
          const path = `${userId}/${item.id}/${safeName(name)}`;
          const { error } = await supabaseBrowser().storage.from(UPLOAD_BUCKET).upload(path, blob, { contentType: type, upsert: false });
          if (error) throw error;
          patch(item.id, { status: "ready", size: blob.size, name, ref: { path, name, mime: type, size: blob.size } });
        } catch {
          patch(item.id, { status: "error", error: "Upload failed" });
        }
      }),
    );
    return skipped;
  }

  function remove(id: string) {
    const item = live.current.find((x) => x.id === id);
    if (item?.preview) URL.revokeObjectURL(item.preview);
    if (item?.ref) supabaseBrowser().storage.from(UPLOAD_BUCKET).remove([item.ref.path]).catch(() => {});
    setItems((list) => list.filter((x) => x.id !== id));
  }

  /** Hands over what's ready to send and empties the tray (the files stay uploaded). */
  function take(): FileRef[] {
    const refs = live.current.flatMap((x) => (x.status === "ready" && x.ref ? [x.ref] : []));
    for (const x of live.current) if (x.preview) URL.revokeObjectURL(x.preview);
    setItems([]);
    return refs;
  }

  return {
    items,
    add,
    remove,
    take,
    uploading: items.some((x) => x.status === "uploading"),
    ready: items.some((x) => x.status === "ready"),
  };
}

/** The files waiting in the message box. */
export function AttachmentTray({ items, onRemove }: { items: Pending[]; onRemove: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <ul className="flex gap-2 overflow-x-auto px-1 pb-2 pt-1" aria-label="Attached files">
      {items.map((x) => (
        <li key={x.id} data-testid="attachment" data-status={x.status} className="relative shrink-0">
          <div
            className={`flex h-16 items-center gap-2 overflow-hidden rounded-2xl border ${x.status === "error" ? "border-fg" : "border-line"} ${x.preview ? "w-16" : "max-w-[220px] px-3 pr-8"}`}
          >
            {x.preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={x.preview} alt={x.name} className={`h-full w-full object-cover ${x.status === "uploading" ? "opacity-40" : ""}`} />
            ) : (
              <>
                <FileIcon className="shrink-0" />
                <span className="min-w-0">
                  <span className="block truncate text-[14px]">{x.name}</span>
                  <span className="block text-[12px] text-mute">
                    {x.status === "error" ? x.error : x.status === "uploading" ? "Uploading…" : sizeLabel(x.size)}
                  </span>
                </span>
              </>
            )}
            {x.preview && x.status !== "ready" ? (
              <span className="absolute inset-x-0 bottom-0 bg-bg/80 px-1 text-center text-[10px] leading-4">
                {x.status === "error" ? x.error : "Uploading…"}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => onRemove(x.id)}
            aria-label={`Remove ${x.name}`}
            className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-inv text-on-inv"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Files on a sent message. Links are short-lived and only work for the person who sent them. */
export function MessageFiles({ files }: { files: FileRef[] }) {
  const [urls, setUrls] = useState<Record<string, string | null>>({});
  const key = files.map((f) => f.path).join("|");
  useEffect(() => {
    let gone = false;
    supabaseBrowser()
      .storage.from(UPLOAD_BUCKET)
      .createSignedUrls(
        files.map((f) => f.path),
        3600,
      )
      .then(({ data }) => {
        if (gone) return;
        const next: Record<string, string | null> = {};
        for (const f of files) next[f.path] = data?.find((d) => d.path === f.path && !d.error)?.signedUrl ?? null;
        setUrls(next);
      });
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <div className="flex flex-wrap justify-end gap-2" data-testid="message-files">
      {files.map((f) => {
        const url = urls[f.path];
        const removed = url === null;
        if (f.mime.startsWith("image/") && url) {
          return (
            <a key={f.path} href={url} target="_blank" rel="noreferrer noopener" className="block overflow-hidden rounded-2xl border border-line">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt={f.name} className="max-h-60 max-w-[240px] object-cover" referrerPolicy="no-referrer" />
            </a>
          );
        }
        const body = (
          <>
            <FileIcon className="shrink-0" />
            <span className="min-w-0">
              <span className="block truncate text-[14px]">{f.name}</span>
              <span className="block text-[12px] text-mute">{removed ? "Removed after 3 days" : sizeLabel(f.size)}</span>
            </span>
          </>
        );
        return url ? (
          <a key={f.path} href={url} target="_blank" rel="noreferrer noopener" className="flex max-w-[260px] items-center gap-2 rounded-2xl border border-line px-3 py-2.5">
            {body}
          </a>
        ) : (
          <div key={f.path} className="flex max-w-[260px] items-center gap-2 rounded-2xl border border-line px-3 py-2.5 text-mute">
            {body}
          </div>
        );
      })}
    </div>
  );
}
