"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "@/components/markdown/Markdown";
import { saveFile } from "@/components/markdown/FileCard";
import { listCanvases, saveCanvas } from "@/app/c/canvas";
import {
  canvasBlocks,
  codeFileName,
  codeLanguage,
  displayTitle,
  fenceFor,
  highlightClass,
  latest,
  type Canvas,
  type CanvasBlock,
  type CanvasVersion,
} from "@/lib/canvas";
import { KINDS, withKind, type DocKind } from "@/lib/docs/kinds";

/**
 * Canvas: a document or piece of code beside the chat (a sheet on phones and tablets) that the
 * person and the AI both edit. The AI writes it as a ```canvas:Title block in a reply; the server
 * keeps every version. The person's edits are saved as their own versions, and the AI gets the
 * current text with their next message.
 */

type Opener = (title: string, messageId?: string) => void;
/** Lets a canvas block in a reply open the pane. Missing (a shared page): the card shows the text instead. */
export const CanvasOpener = createContext<Opener | null>(null);
/** The reply a canvas block is in, so its card opens the version that reply wrote. */
export const CanvasMessage = createContext<string | null>(null);

export const CanvasIcon = ({ className }: { className?: string }) => (
  <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
    <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
    <path d="M13 4v16M16 8.5h2M16 12h2" />
  </svg>
);

const sameTitle = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A canvas block inside a reply: a small card that opens the pane. */
export function CanvasCard({ title, content, streaming }: { title: string; content: string; streaming: boolean }) {
  const open = useContext(CanvasOpener);
  const messageId = useContext(CanvasMessage);
  const [shown, setShown] = useState(false);
  const language = codeLanguage(title);
  const lines = content ? content.split("\n").length : 0;
  return (
    <div className="md-file" data-testid="canvas-card">
      <div className="flex items-center gap-3">
        <span className="md-file-icon" aria-hidden>
          <CanvasIcon />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{displayTitle(title)}</span>
          <span className="block text-[13px] text-mute">
            {streaming ? "Writing in the canvas…" : `${language ?? "Document"} · ${lines} ${lines === 1 ? "line" : "lines"}`}
          </span>
        </span>
        {open ? (
          <button
            type="button"
            className="press inline-flex h-10 shrink-0 items-center rounded-full bg-inv px-4 text-[15px] font-semibold text-on-inv"
            onClick={() => open(title, messageId ?? undefined)}
            aria-label={`Open ${displayTitle(title)} in the canvas`}
          >
            Open
          </button>
        ) : null}
      </div>
      {!open && !streaming ? (
        <div className="md-file-more">
          <button type="button" onClick={() => setShown(!shown)} aria-expanded={shown}>
            {shown ? "Hide contents" : "Show contents"}
          </button>
        </div>
      ) : null}
      {shown ? <pre className="md-file-source">{content}</pre> : null}
    </div>
  );
}

type View = { id: string; versionId: string | null } | null;

/**
 * The chat's canvases, which one is open, and the person's unsaved edit. `streamingText` is the
 * reply being written, so a canvas it writes shows in the pane as it arrives.
 */
export function useCanvas(chatId: string | null, streamingText: string | null, finishedText: string | null) {
  const [canvases, setCanvases] = useState<Canvas[]>([]);
  const [view, setView] = useState<View>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Closing the pane while the AI writes keeps it closed until that reply is done.
  const [liveDismissed, setLiveDismissed] = useState(false);

  const refresh = useCallback(async () => {
    if (!chatId) return [] as Canvas[];
    const next = await listCanvases(chatId).catch(() => null);
    if (next) setCanvases(next);
    return next ?? [];
  }, [chatId]);
  useEffect(() => {
    setCanvases([]);
    setView(null);
    setDraft(null);
    refresh();
  }, [refresh]);

  const live: CanvasBlock | null = useMemo(() => {
    if (streamingText === null) return null;
    return canvasBlocks(streamingText).at(-1) ?? null;
  }, [streamingText]);

  // When a reply finishes, show the canvas it wrote, now saved. (Safari can deliver a short reply
  // in one go, so this looks at the finished reply rather than relying on having seen it stream.)
  const wasWriting = useRef(false);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const dismissedRef = useRef(liveDismissed);
  dismissedRef.current = liveDismissed;
  useEffect(() => {
    if (streamingText !== null) {
      wasWriting.current = true;
      return;
    }
    if (!wasWriting.current) return;
    wasWriting.current = false;
    const dismissed = dismissedRef.current;
    setLiveDismissed(false);
    const title = canvasBlocks(finishedText ?? "").filter((b) => b.closed).at(-1)?.title;
    if (!title || dismissed) return;
    refreshRef.current().then((list) => {
      const made = list.find((c) => sameTitle(c.title, title));
      if (made) {
        setView({ id: made.id, versionId: null });
        setDraft(null);
      }
    });
  }, [streamingText, finishedText]);

  const current = view ? canvases.find((c) => c.id === view.id) ?? null : null;
  const newest = current ? latest(current) : undefined;

  const save = useCallback(async (): Promise<boolean> => {
    if (!current || draft === null || draft === newest?.content) {
      setDraft(null);
      return true;
    }
    setSaving(true);
    setError(null);
    const { version, error: failed } = await saveCanvas(current.id, draft).catch(() => ({ version: undefined, error: "Couldn't save your changes. Try again." }));
    setSaving(false);
    if (!version) {
      setError(failed ?? "Couldn't save your changes. Try again.");
      return false;
    }
    setCanvases((list) => list.map((c) => (c.id === current.id ? { ...c, updated_at: version.created_at, versions: [...c.versions, version] } : c)));
    setDraft(null);
    return true;
  }, [current, draft, newest]);

  // Leaving the app on a phone can end the page: save on the way out.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const away = () => document.visibilityState === "hidden" && saveRef.current();
    document.addEventListener("visibilitychange", away);
    return () => document.removeEventListener("visibilitychange", away);
  }, []);

  const open: Opener = useCallback(
    (title, messageId) => {
      const c = canvases.find((x) => sameTitle(x.title, title));
      if (!c) {
        // Just written and not loaded yet.
        refresh().then((list) => {
          const found = list.find((x) => sameTitle(x.title, title));
          if (found) setView({ id: found.id, versionId: null });
        });
        return;
      }
      const v = messageId ? c.versions.find((x) => x.message_id === messageId) : undefined;
      setView({ id: c.id, versionId: v && v.id !== latest(c)?.id ? v.id : null });
      setDraft(null);
    },
    [canvases, refresh],
  );

  return {
    canvases,
    refresh,
    current,
    view,
    live: live && !liveDismissed ? live : null,
    draft,
    setDraft,
    saving,
    error,
    open,
    showVersion: (versionId: string | null) => view && setView({ ...view, versionId }),
    close: async () => {
      if (live) setLiveDismissed(true);
      await save();
      setView(null);
    },
    restore: async (v: CanvasVersion) => {
      if (!current) return;
      setView({ id: current.id, versionId: null });
      setDraft(v.content);
    },
    save,
    /** Before a message is sent: save any edit, and say which canvas the AI should work on. */
    beforeSend: async (): Promise<{ canvasId?: string }> => {
      await save();
      return current && view ? { canvasId: current.id } : {};
    },
    isOpen: Boolean((live && !liveDismissed) || current),
  };
}

export type CanvasState = ReturnType<typeof useCanvas>;

const DOC_EXPORTS: DocKind[] = ["docx", "pdf", "md"];

/** The pane itself: beside the chat on wide screens, a sheet from the bottom on phones and tablets. */
export function CanvasPane({ state }: { state: CanvasState }) {
  const { current, live, view, draft } = state;
  const [menu, setMenu] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);

  const title = live?.title ?? current?.title ?? "";
  const versions = current?.versions ?? [];
  const index = current ? (view?.versionId ? versions.findIndex((v) => v.id === view.versionId) : versions.length - 1) : -1;
  const shown = live ? undefined : versions[index];
  const old = !live && index >= 0 && index < versions.length - 1;
  const text = live ? live.content : draft ?? shown?.content ?? "";
  const editing = draft !== null && !live;
  const language = codeLanguage(title);

  useEffect(() => {
    if (editing) editor.current?.focus({ preventScroll: true });
  }, [editing]);

  // Keep the newest text in view while the AI writes.
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (live && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [live, text]);

  const flash = (msg: string) => {
    setNote(msg);
    setTimeout(() => setNote(null), 1800);
  };

  async function download(kind: DocKind | "code") {
    setMenu(false);
    try {
      if (kind === "code") {
        await saveFile(new Blob([text], { type: "text/plain;charset=utf-8" }), codeFileName(title));
        return;
      }
      const { buildFile } = await import("@/lib/docs/write");
      const fileName = withKind(title.replace(/\.(md|markdown)$/i, ""), kind);
      const built = await buildFile(kind, text, fileName);
      await saveFile(built.blob, fileName);
      if (built.lossy) flash("Some letters can't go in a PDF. The Word version keeps them all.");
    } catch {
      flash("Couldn't make that file. Try again.");
    }
  }

  if (!state.isOpen) return null;
  const who = (v: CanvasVersion | undefined) => (v ? (v.author === "person" ? "edited by you" : "written by the AI") : "");
  const status = live
    ? "The AI is writing…"
    : state.saving
      ? "Saving…"
      : state.error
        ? state.error
        : note ?? (versions.length ? `Version ${index + 1} of ${versions.length} · ${who(shown)}` : "");

  return (
    <>
      {/* Phones and tablets: dim the chat behind the sheet. */}
      <button type="button" aria-label="Close canvas" className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={state.close} />
      <section
        aria-label={`Canvas: ${displayTitle(title)}`}
        data-testid="canvas"
        className="enter-glitch fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-[22px] border-t border-line bg-bg shadow-2xl lg:static lg:z-auto lg:w-[50vw] lg:max-w-[900px] lg:shrink-0 lg:rounded-none lg:border-l lg:border-t-0 lg:shadow-none"
        style={{ top: "max(2.75rem, calc(env(safe-area-inset-top) + 1rem))" }}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-line lg:hidden" aria-hidden />
        <header className="flex items-center gap-1 border-b border-line px-3 py-2 lg:px-4">
          <div className="min-w-0 flex-1 px-1">
            <h2 className="truncate text-[17px] font-semibold">{displayTitle(title)}</h2>
            <p role="status" className="truncate text-[13px] text-mute" data-testid="canvas-status">
              {status}
            </p>
          </div>
          {!live && versions.length > 1 ? (
            <>
              <button
                type="button"
                className="press rounded-full p-2 text-mute hover:text-fg disabled:opacity-30"
                aria-label="Older version"
                disabled={index <= 0 || editing}
                onClick={() => state.showVersion(versions[index - 1].id)}
              >
                <Chevron left />
              </button>
              <button
                type="button"
                className="press rounded-full p-2 text-mute hover:text-fg disabled:opacity-30"
                aria-label="Newer version"
                disabled={!old || editing}
                onClick={() => state.showVersion(index + 1 === versions.length - 1 ? null : versions[index + 1].id)}
              >
                <Chevron />
              </button>
            </>
          ) : null}
          {!live && current ? (
            old ? (
              <button type="button" className="press h-9 rounded-full border border-line px-3.5 text-[14px]" onClick={() => shown && state.restore(shown)}>
                Restore
              </button>
            ) : editing ? (
              <button
                type="button"
                className="press h-9 rounded-full bg-inv px-4 text-[14px] font-semibold text-on-inv"
                disabled={state.saving}
                onClick={() => state.save()}
              >
                Done
              </button>
            ) : (
              <button type="button" className="press h-9 rounded-full border border-line px-3.5 text-[14px]" onClick={() => state.setDraft(shown?.content ?? "")}>
                Edit
              </button>
            )
          ) : null}
          {!live && current ? (
            <div className="relative">
              <button type="button" className="press rounded-full p-2 text-mute hover:text-fg" aria-label="Copy or download" aria-expanded={menu} onClick={() => setMenu(!menu)}>
                <DownloadIcon />
              </button>
              {menu ? (
                <>
                  <button type="button" aria-label="Close" className="fixed inset-0 z-20 cursor-default" onClick={() => setMenu(false)} />
                  <div role="menu" className="absolute right-0 top-11 z-30 w-52 overflow-hidden rounded-2xl border border-line bg-bg py-1 text-[16px] shadow-lg">
                    <button
                      type="button"
                      role="menuitem"
                      className="block w-full px-4 py-2.5 text-left hover:bg-soft"
                      onClick={async () => {
                        setMenu(false);
                        await navigator.clipboard.writeText(text);
                        flash("Copied");
                      }}
                    >
                      Copy text
                    </button>
                    {language ? (
                      <button type="button" role="menuitem" className="block w-full px-4 py-2.5 text-left hover:bg-soft" onClick={() => download("code")}>
                        Download {codeFileName(title)}
                      </button>
                    ) : (
                      DOC_EXPORTS.map((k) => (
                        <button key={k} type="button" role="menuitem" className="block w-full px-4 py-2.5 text-left hover:bg-soft" onClick={() => download(k)}>
                          Download as {KINDS[k].short}
                        </button>
                      ))
                    )}
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
          <button type="button" className="press rounded-full p-2 text-mute hover:text-fg" aria-label="Close canvas" onClick={state.close}>
            <CloseIcon />
          </button>
        </header>
        <div ref={body} className="min-h-0 flex-1 overflow-y-auto overscroll-contain" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
          {editing ? (
            <textarea
              ref={editor}
              value={text}
              onChange={(e) => state.setDraft(e.target.value)}
              aria-label={`Edit ${displayTitle(title)}`}
              spellCheck={!language}
              className={`block h-full min-h-full w-full resize-none bg-transparent px-5 py-5 outline-none lg:px-8 ${language ? "font-mono text-[14px] leading-6" : "text-[17px] leading-7"}`}
            />
          ) : (
            <div
              className="mx-auto w-full max-w-[720px] px-5 py-5 lg:px-8"
              data-testid="canvas-text"
              onDoubleClick={() => !live && !old && current && state.setDraft(shown?.content ?? "")}
            >
              {language ? (
                <Markdown text={`${fenceFor(text)}${highlightClass(title)?.slice(9) ?? ""}\n${text}\n${fenceFor(text)}`} streaming={Boolean(live)} />
              ) : (
                <Markdown text={text} streaming={Boolean(live)} />
              )}
              {live ? <span className="stream-cursor" aria-label="Writing" /> : null}
            </div>
          )}
        </div>
      </section>
    </>
  );
}

const Chevron = ({ left }: { left?: boolean }) => (
  <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={left ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} />
  </svg>
);
const CloseIcon = () => (
  <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
const DownloadIcon = () => (
  <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14" />
  </svg>
);
