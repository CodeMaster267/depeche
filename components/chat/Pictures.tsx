"use client";

import { useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { UPLOAD_BUCKET, type FileRef } from "@/lib/chat/files";
import { BrushIcon, CloseIcon, DownloadIcon } from "./icons";

/** Short-lived links to pictures in your own folder (null once a picture has been removed). */
function useSignedUrls(files: FileRef[]): Record<string, string | null> {
  const [urls, setUrls] = useState<Record<string, string | null>>({});
  const key = files.map((f) => f.path).join("|");
  useEffect(() => {
    if (!files.length) return;
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
  return urls;
}

export const isPicture = (f: FileRef) => f.mime.startsWith("image/");

/** Pictures a picture model made, each with Edit and Download. */
export function ReplyPictures({ files, onEdit }: { files: FileRef[]; onEdit?: (f: FileRef) => void }) {
  const urls = useSignedUrls(files);
  return (
    <div className="flex flex-col gap-3" data-testid="reply-pictures">
      {files.filter(isPicture).map((f) => (
        <Picture key={f.path} file={f} url={urls[f.path]} onEdit={onEdit} />
      ))}
    </div>
  );
}

function Picture({ file, url, onEdit }: { file: FileRef; url: string | null | undefined; onEdit?: (f: FileRef) => void }) {
  // Fetched as soon as it shows, so Download can open the share sheet straight away on iPhone
  // (Safari only allows that right after a tap).
  const blob = useRef<Blob | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    blob.current = null;
    if (!url) return;
    let gone = false;
    fetch(url)
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (!gone) blob.current = b;
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [url]);

  const download = async () => {
    if (!url) return;
    setSaving(true);
    try {
      const b = blob.current ?? (await (await fetch(url)).blob());
      const asFile = new File([b], file.name, { type: file.mime });
      // On phones the share sheet has "Save Image", which puts it in Photos.
      const touch = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
      if (touch && navigator.canShare?.({ files: [asFile] })) {
        await navigator.share({ files: [asFile] }).catch(() => {});
        return;
      }
      const href = URL.createObjectURL(b);
      const a = document.createElement("a");
      a.href = href;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } finally {
      setSaving(false);
    }
  };

  if (url === null) {
    return (
      <p className="rounded-2xl border border-line px-4 py-3 text-[15px] text-mute" data-testid="picture-removed">
        This picture was removed after 3 days without use.
      </p>
    );
  }
  return (
    <figure className="flex flex-col gap-1.5">
      {url ? (
        <a href={url} target="_blank" rel="noreferrer noopener" className="block w-fit overflow-hidden rounded-[22px] border border-line">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={file.name.replace(/\.\w+$/, "").replace(/-/g, " ")}
            data-testid="picture"
            className="block h-auto max-h-[70dvh] w-auto max-w-full"
            referrerPolicy="no-referrer"
          />
        </a>
      ) : (
        <div className="aspect-square w-full max-w-[420px] rounded-[22px] bg-soft" aria-label="Loading picture" />
      )}
      <figcaption className="-ml-2 flex items-center gap-1 text-mute">
        {onEdit ? (
          <button type="button" className="press flex items-center gap-1.5 rounded-lg p-2 text-[14px] hover:text-fg" onClick={() => onEdit(file)}>
            <BrushIcon className="h-5 w-5" /> Edit
          </button>
        ) : null}
        <button
          type="button"
          className="press flex items-center gap-1.5 rounded-lg p-2 text-[14px] hover:text-fg disabled:opacity-40"
          onClick={download}
          disabled={!url || saving}
          aria-label={`Download ${file.name}`}
        >
          <DownloadIcon className="h-5 w-5" /> Download
        </button>
      </figcaption>
    </figure>
  );
}

/** Shown while a picture is being made: a blank frame with the glitch cursor. */
export function MakingPicture({ editing }: { editing?: boolean }) {
  return (
    <div
      role="status"
      data-testid="making-picture"
      className="flex aspect-square w-full max-w-[320px] flex-col items-center justify-center gap-3 rounded-[22px] border border-line bg-soft text-[15px] text-mute"
    >
      <span className="stream-cursor" aria-hidden />
      {editing ? "Editing the picture…" : "Making the picture…"}
      <span className="px-6 text-center text-[13px] text-faint">This can take a minute.</span>
    </div>
  );
}

/** Above the message box: the picture your next message will change. */
export function EditingChip({ file, onClear }: { file: FileRef; onClear: () => void }) {
  const url = useSignedUrls([file])[file.path];
  return (
    <div className="flex items-center gap-2 px-1 pb-2 pt-1" data-testid="editing-chip">
      <span className="h-10 w-10 shrink-0 overflow-hidden rounded-xl border border-line bg-soft">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : null}
      </span>
      <span className="min-w-0 flex-1 text-[14px]">
        <span className="block">Editing this picture</span>
        <span className="block text-[12px] text-mute">Tap × to make a new one instead</span>
      </span>
      <button
        type="button"
        onClick={onClear}
        aria-label="Make a new picture instead"
        className="press flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-inv text-on-inv"
      >
        <CloseIcon className="h-4 w-4" />
      </button>
    </div>
  );
}
