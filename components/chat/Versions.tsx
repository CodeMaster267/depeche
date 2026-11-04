"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { MessageRow } from "@/lib/chat/thread";
import { MessageFiles } from "./Attachments";
import { QuoteLine } from "./Extras";
import { ChevronLeftIcon, ChevronRightIcon, CopyIcon, EditIcon } from "./icons";

/** "‹ 2 / 3 ›": flip between versions of a message (its edits, or a reply's regenerations). */
export function VersionSwitch({
  index,
  total,
  onPick,
  disabled,
  what,
}: {
  index: number;
  total: number;
  onPick: (index: number) => void;
  disabled?: boolean;
  what: "message" | "reply";
}) {
  if (total < 2) return null;
  return (
    <span className="flex items-center text-mute" data-testid={`${what}-versions`} role="group" aria-label={`Versions of this ${what}`}>
      <button
        type="button"
        className="press flex h-9 w-8 items-center justify-center rounded-lg hover:text-fg disabled:opacity-30"
        aria-label={`Previous version of this ${what}`}
        disabled={disabled || index === 0}
        onClick={() => onPick(index - 1)}
      >
        <ChevronLeftIcon className="h-[18px] w-[18px]" />
      </button>
      <span className="min-w-[2.6em] text-center font-mono text-[13px] tabular-nums" aria-live="polite">
        {index + 1}/{total}
      </span>
      <button
        type="button"
        className="press flex h-9 w-8 items-center justify-center rounded-lg hover:text-fg disabled:opacity-30"
        aria-label={`Next version of this ${what}`}
        disabled={disabled || index === total - 1}
        onClick={() => onPick(index + 1)}
      >
        <ChevronRightIcon className="h-[18px] w-[18px]" />
      </button>
    </span>
  );
}

/**
 * One of your own messages, with Edit and its versions. Editing sends the changed message as a new
 * version beside the original (which is kept) and the conversation carries on from there.
 */
export function UserMessage({
  message: m,
  versions,
  busy,
  onEdit,
  onPickVersion,
}: {
  message: MessageRow;
  versions: MessageRow[];
  busy: boolean;
  onEdit: (text: string) => void;
  onPickVersion: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = m.content.text ?? "";
  const index = Math.max(0, versions.findIndex((v) => v.id === m.id));
  const local = m.id.startsWith("local-");

  return (
    <div className="msg-row flex flex-col items-end gap-1.5">
      {m.content.quote ? <QuoteLine quote={m.content.quote} /> : null}
      {m.content.files?.length ? <MessageFiles files={m.content.files} /> : null}
      {editing ? (
        <EditBox
          initial={text}
          canSendEmpty={!!m.content.files?.length}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSend={(t) => {
            setEditing(false);
            onEdit(t);
          }}
        />
      ) : text ? (
        <div
          data-testid="user-message"
          className="max-w-[85%] whitespace-pre-wrap break-words rounded-[22px] bg-inv px-5 py-3 text-[17px] leading-relaxed text-on-inv"
        >
          {text}
        </div>
      ) : null}
      {!editing && !local ? (
        <div className="msg-tools -mr-1 flex items-center text-mute" data-idle={versions.length < 2 ? "" : undefined}>
          {text ? (
            <button
              type="button"
              className="press flex h-9 w-9 items-center justify-center rounded-lg hover:text-fg"
              aria-label={copied ? "Copied" : "Copy message"}
              onClick={async () => {
                await navigator.clipboard.writeText(text).catch(() => {});
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              <CopyIcon className="h-[18px] w-[18px]" />
            </button>
          ) : null}
          <button
            type="button"
            className="press flex h-9 w-9 items-center justify-center rounded-lg hover:text-fg disabled:opacity-30"
            aria-label="Edit message"
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            <EditIcon className="h-[18px] w-[18px]" />
          </button>
          <VersionSwitch what="message" index={index} total={versions.length} disabled={busy} onPick={(i) => onPickVersion(versions[i].id)} />
        </div>
      ) : null}
    </div>
  );
}

function EditBox({
  initial,
  canSendEmpty,
  busy,
  onCancel,
  onSend,
}: {
  initial: string;
  canSendEmpty: boolean;
  busy: boolean;
  onCancel: () => void;
  onSend: (text: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const box = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [value]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    // Put the caret at the end without scrolling the page on iPhone.
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const trimmed = value.trim();
  const changed = trimmed !== initial.trim();
  const ok = !busy && changed && (trimmed.length > 0 || canSendEmpty);
  return (
    <form
      className="w-full max-w-[85%] rounded-[22px] border border-fg bg-bg p-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onSend(trimmed);
      }}
    >
      <textarea
        ref={box}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
            e.preventDefault();
            if (ok) onSend(trimmed);
          }
        }}
        aria-label="Edit your message"
        rows={1}
        className="block max-h-[320px] min-h-[44px] w-full resize-none bg-transparent px-3 py-2 text-[17px] leading-relaxed outline-none"
      />
      <div className="flex items-center justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="press h-10 rounded-full px-4 text-[15px] text-mute hover:text-fg">
          Cancel
        </button>
        <button type="submit" disabled={!ok} className="press h-10 rounded-full bg-inv px-4 text-[15px] font-medium text-on-inv disabled:opacity-30">
          Send
        </button>
      </div>
    </form>
  );
}
