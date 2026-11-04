"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { GlassCode } from "@/components/Glass";
import { keepChats } from "@/app/c/actions";
import type { Expiring } from "@/lib/chat/load";
import { Sheet } from "./ChatMenu";
import { CloseIcon } from "./icons";
import { whenDeleted } from "@/lib/chat/expiring";

const SEEN = "depeche:expiring-closed";
const today = () => new Date().toLocaleDateString("en-CA");


/**
 * Chats the monthly clean-up is about to delete. A quiet line at the top of the chat screen, once a
 * day: closing it hides it until tomorrow, and it comes back each day while something is still due.
 * Review lists them with Keep on each; keeping restarts a chat's month without moving it.
 */
export function DeletionNotice({ expiring, onKept }: { expiring: Expiring[]; onKept: (ids: string[]) => void }) {
  const [closed, setClosed] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    try {
      setClosed(localStorage.getItem(SEEN) === today());
    } catch {
      setClosed(false); // storage blocked: just show it
    }
  }, []);

  const keep = async (ids: string[]) => {
    setSaving(true);
    try {
      await keepChats(ids);
      onKept(ids);
    } finally {
      setSaving(false);
    }
  };

  if (!expiring.length) return null;
  const n = expiring.length;
  const line = `${n} chat${n === 1 ? "" : "s"} will be deleted soon for not being used in a month.`;

  return (
    <>
      {!closed ? (
        <div className="flex items-center gap-2 border-b border-line py-1.5 pl-4 pr-1.5 text-[14px] md:pl-6" role="status" data-testid="deletion-notice">
          <span className="min-w-0 flex-1 text-mute">{line}</span>
          <button type="button" className="press shrink-0 rounded-full border border-line px-3 py-1 text-fg" onClick={() => setOpen(true)}>
            Review
          </button>
          <button
            type="button"
            aria-label="Hide until tomorrow"
            className="shrink-0 p-2 text-mute"
            onClick={() => {
              setClosed(true);
              try {
                localStorage.setItem(SEEN, today());
              } catch {
                // Not remembered; it shows again next time.
              }
            }}
          >
            <CloseIcon />
          </button>
        </div>
      ) : null}
      {open ? (
        <Sheet label="Chats about to be deleted" onClose={() => setOpen(false)}>
          <p className="text-[15px] text-mute">Chats you haven&apos;t used for a month are deleted. Keep any you want for another month.</p>
          <ul className="-mx-2 mt-3 max-h-[45dvh] overflow-y-auto overscroll-contain">
            {expiring.map((c) => (
              <li key={c.id} className="flex items-center gap-3 rounded-xl px-2 py-2.5">
                <span className="min-w-0 flex-1">
                  <Link href={`/c/${c.id}`} prefetch={false} onClick={() => setOpen(false)} className="block truncate text-[16px]">
                    {c.title}
                  </Link>
                  <span className="block text-[13px] text-mute">
                    {whenDeleted(c.deletes_at)}
                    {c.archived ? " · archived" : ""}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={saving}
                  className="press shrink-0 rounded-full border border-line px-3.5 py-1.5 text-[15px]"
                  onClick={() => keep([c.id])}
                >
                  Keep
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={saving}
            data-busy={saving ? "" : undefined}
            className="press glass glass-pill mt-4 flex h-12 w-full items-center justify-center text-[16px] font-medium"
            onClick={async () => {
              await keep(expiring.map((c) => c.id));
              setOpen(false);
            }}
          >
            <GlassCode seed="keep all" />
            <span>{n === 1 ? "Keep it" : `Keep all ${n}`}</span>
          </button>
          <p className="mt-4 text-center text-[14px] text-mute">
            Never want chats deleted?{" "}
            <Link href="/account" className="text-fg underline underline-offset-4" onClick={() => setOpen(false)}>
              Keep all my chats
            </Link>
          </p>
        </Sheet>
      ) : null}
    </>
  );
}
