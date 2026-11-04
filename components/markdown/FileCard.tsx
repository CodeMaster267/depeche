"use client";

import { useEffect, useRef, useState } from "react";
import { KINDS, alternatives, withKind, type Built, type DocKind } from "@/lib/docs/kinds";
import { sizeLabel } from "@/lib/chat/files";

/**
 * A file the model made: a ```file:Name.ext block in its reply, shown as a card with Download.
 * The file is made here in the browser from the block's contents, so nothing is uploaded or kept.
 * The main file is made as soon as the reply finishes, so tapping Download can open the share
 * sheet straight away on iPhone (it only opens directly from a tap).
 */
const load = () => import("@/lib/docs/write");

async function save(built: Built, name: string) {
  const file = new File([built.blob], name, { type: built.blob.type.split(";")[0] });
  // Phones and tablets get the share sheet: Save to Files, AirDrop, Mail, open in Word and so on.
  if (matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if ((e as Error).name === "AbortError") return; // they closed the sheet
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function FileCard({ name, kind, content, streaming }: { name: string; kind: DocKind; content: string; streaming: boolean }) {
  const [built, setBuilt] = useState<Built | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<DocKind | null>(null);
  const [open, setOpen] = useState(false);
  const made = useRef<Partial<Record<DocKind, Built>>>({});

  useEffect(() => {
    if (streaming) return;
    let gone = false;
    made.current = {};
    setBuilt(null);
    setFailed(false);
    load()
      .then((m) => m.buildFile(kind, content, name))
      .then((b) => {
        if (gone) return;
        made.current[kind] = b;
        setBuilt(b);
      })
      .catch(() => !gone && setFailed(true));
    return () => {
      gone = true;
    };
  }, [kind, content, name, streaming]);

  async function download(as: DocKind) {
    setBusy(as);
    try {
      const b = made.current[as] ?? (made.current[as] = await (await load()).buildFile(as, content, withKind(name, as)));
      await save(b, as === kind ? name : withKind(name, as));
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }

  const info = KINDS[kind];
  const status = streaming ? "Writing…" : failed ? "Couldn't make this file" : built ? `${info.label} · ${sizeLabel(built.blob.size)}` : info.label;
  return (
    <div className="md-file" data-testid="file-card" data-ready={built && !streaming ? "true" : undefined}>
      <div className="flex items-center gap-3">
        <span className="md-file-icon" aria-hidden>
          {kind.toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{name}</span>
          <span className="block text-[13px] text-mute">{status}</span>
        </span>
        <button
          type="button"
          className="press inline-flex h-10 shrink-0 items-center rounded-full bg-inv px-4 text-[15px] font-semibold text-on-inv disabled:opacity-50"
          disabled={streaming || !built || busy !== null}
          onClick={() => download(kind)}
          aria-label={`Download ${name}`}
        >
          {busy === kind ? "Saving…" : "Download"}
        </button>
      </div>
      {built?.lossy ? (
        <p className="mt-2 text-[13px] text-mute">Some letters can&apos;t go in a PDF and show as “?”. The Word version keeps them all.</p>
      ) : null}
      {!streaming ? (
        <div className="md-file-more">
          {alternatives(kind).map((k) => (
            <button key={k} type="button" disabled={busy !== null} onClick={() => download(k)}>
              {busy === k ? "Saving…" : `As ${KINDS[k].short}`}
            </button>
          ))}
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Hide contents" : "Show contents"}
          </button>
        </div>
      ) : null}
      {open ? <pre className="md-file-source">{content}</pre> : null}
    </div>
  );
}
