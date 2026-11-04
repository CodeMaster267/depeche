"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { GlassCode } from "@/components/Glass";
import { archiveChat, deleteChat, pinChat, renameChat } from "@/app/c/actions";
import type { ChatRow } from "@/lib/chat/thread";
import { MoreIcon } from "./icons";

const ITEM = "flex w-full items-center px-4 py-3 text-left text-[16px] hover:bg-soft focus-visible:bg-soft outline-none";

/**
 * The three dots on a chat (in the chat list and in an open chat's header): rename, pin, archive
 * or restore, download, and delete. The menu floats above everything (it is drawn at the end of the page),
 * so the chat list's scrolling never cuts it off, and it opens upwards near the bottom of the screen.
 * Rename and delete open a small sheet of their own rather than the browser's prompt boxes.
 */
export function ChatMenu({
  chat,
  userId,
  onChange,
  onDeleted,
  className = "p-2 text-mute",
  label = "Chat options",
}: {
  chat: ChatRow;
  /** Whose chat it is, for Download (the browser reads the chat itself, under row-level security). */
  userId: string;
  /** The chat after a rename, pin or archive, shown straight away while the server catches up. */
  onChange: (next: ChatRow) => void;
  onDeleted: () => void;
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState<"rename" | "delete" | null>(null);
  const [at, setAt] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const archived = !!chat.archived_at;

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const right = Math.max(8, window.innerWidth - r.right);
    // Open upwards when there isn't room for the menu below the dots.
    setAt(window.innerHeight - r.bottom < 260 ? { bottom: window.innerHeight - r.top + 4, right } : { top: r.bottom + 4, right });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={className}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          // In the chat list the dots sit on the chat's link; opening the menu mustn't open the chat.
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <MoreIcon />
      </button>
      {open && at
        ? createPortal(
            <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)}>
              <div
                ref={menu}
                role="menu"
                aria-label={label}
                onClick={(e) => e.stopPropagation()}
                className="menu-pop absolute w-52 overflow-hidden rounded-2xl border border-line bg-bg py-1.5 shadow-[0_18px_40px_-18px_rgba(0,0,0,0.45)]"
                style={{ top: at.top, bottom: at.bottom, right: at.right }}
              >
                <button type="button" role="menuitem" className={ITEM} onClick={pick(() => setSheet("rename"))}>
                  Rename
                </button>
                {!archived ? (
                  <button
                    type="button"
                    role="menuitem"
                    className={ITEM}
                    onClick={pick(() => {
                      onChange({ ...chat, pinned: !chat.pinned });
                      pinChat(chat.id, !chat.pinned).catch(() => {});
                    })}
                  >
                    {chat.pinned ? "Unpin" : "Pin"}
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  className={ITEM}
                  onClick={pick(() => {
                    onChange({ ...chat, archived_at: archived ? null : new Date().toISOString() });
                    archiveChat(chat.id, !archived).catch(() => {});
                  })}
                >
                  {archived ? "Restore" : "Archive"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={ITEM}
                  onClick={pick(async () => {
                    try {
                      const [{ supabaseBrowser }, { downloadChat }] = await Promise.all([import("@/lib/supabase/browser"), import("@/lib/export/collect")]);
                      await downloadChat(supabaseBrowser(), userId, chat.id);
                    } catch {
                      window.alert("Couldn't download this chat. Try again.");
                    }
                  })}
                >
                  Download
                </button>
                <div className="my-1.5 h-px bg-line" />
                <button type="button" role="menuitem" className={ITEM} onClick={pick(() => setSheet("delete"))}>
                  Delete
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
      {sheet === "rename" ? (
        <RenameSheet
          title={chat.title}
          onClose={() => setSheet(null)}
          onSave={(title) => {
            setSheet(null);
            if (title === chat.title) return;
            onChange({ ...chat, title });
            renameChat(chat.id, title).catch(() => {});
          }}
        />
      ) : null}
      {sheet === "delete" ? (
        <Sheet label="Delete chat" onClose={() => setSheet(null)}>
          <p className="text-[16px] text-mute">
            &ldquo;<span className="text-fg">{chat.title}</span>&rdquo; and its files will be deleted for good. This can&apos;t be undone.
          </p>
          <div className="mt-6 flex gap-3">
            <button type="button" className="press h-12 flex-1 rounded-full border border-line text-[16px]" onClick={() => setSheet(null)}>
              Cancel
            </button>
            <DangerButton
              onClick={async () => {
                await deleteChat(chat.id).catch(() => {});
                setSheet(null);
                onDeleted();
              }}
            >
              Delete
            </DangerButton>
          </div>
        </Sheet>
      ) : null}
    </>
  );
}

function DangerButton({ onClick, children }: { onClick: () => Promise<void>; children: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      data-busy={busy ? "" : undefined}
      className="press glass glass-pill flex h-12 flex-1 items-center justify-center text-[16px] font-medium"
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
    >
      <GlassCode seed={children} />
      <span>{busy ? "Deleting…" : children}</span>
    </button>
  );
}

function RenameSheet({ title, onSave, onClose }: { title: string; onSave: (title: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(title);
  const clean = value.trim().replace(/\s+/g, " ").slice(0, 200);
  return (
    <Sheet label="Rename chat" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (clean) onSave(clean);
        }}
      >
        <input
          autoFocus
          value={value}
          maxLength={200}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Chat name"
          enterKeyHint="done"
          className="h-12 w-full rounded-2xl bg-soft px-4 text-[17px] outline-none focus-visible:ring-1 focus-visible:ring-fg"
        />
        <div className="mt-6 flex gap-3">
          <button type="button" className="press h-12 flex-1 rounded-full border border-line text-[16px]" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!clean}
            className="press glass glass-pill flex h-12 flex-1 items-center justify-center text-[16px] font-medium disabled:opacity-50"
          >
            <GlassCode seed="save" />
            <span>Save</span>
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/** A small sheet: slides up from the bottom on phones, a centred card on wider screens. */
export function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center" role="presentation">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="enter-glitch relative w-full rounded-t-[28px] bg-bg px-6 pt-5 sm:max-w-[420px] sm:rounded-[24px] sm:border sm:border-line sm:pb-6"
        style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
      >
        <div className="mx-auto -mt-2.5 mb-4 h-1.5 w-10 rounded-full bg-line sm:hidden" />
        <h2 className="mb-4 text-[24px] font-semibold tracking-tight">{label}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}
