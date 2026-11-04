"use client";

import { useEffect, useState } from "react";
import { GlassCode } from "@/components/Glass";
import { getShare, shareChat, stopSharing, type ShareState } from "@/app/c/share";

const SECONDARY = "press h-12 flex-1 rounded-full border border-line text-[16px] disabled:opacity-50";
const PRIMARY = "press glass glass-pill flex h-12 flex-1 items-center justify-center text-[16px] font-medium disabled:opacity-50";

/**
 * Inside the Share sheet of a chat's menu. Sharing makes a read-only copy of the chat as it is now,
 * opened with a link. The copy doesn't change when the chat does, unless you update it, and
 * stopping sharing makes the link stop working.
 */
export function ShareBody({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const [share, setShare] = useState<ShareState | undefined>(undefined);
  const [busy, setBusy] = useState<"create" | "update" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let gone = false;
    getShare(chatId)
      .then((s) => !gone && setShare(s))
      .catch(() => !gone && (setShare(null), setError("Couldn't check this chat's link. Try again.")));
    return () => {
      gone = true;
    };
  }, [chatId]);

  const make = async (kind: "create" | "update") => {
    setBusy(kind);
    setError(null);
    try {
      const r = await shareChat(chatId);
      if (r.share) setShare(r.share);
      else setError(r.error ?? "Couldn't share this chat. Try again.");
    } catch {
      setError("Couldn't share this chat. Try again.");
    } finally {
      setBusy(null);
    }
  };

  if (share === undefined) return <p className="pb-2 text-[16px] text-mute">Checking…</p>;

  if (!share) {
    return (
      <div>
        <p className="text-[16px] text-mute">
          Anyone with the link can read this chat as it is now. Messages you send later aren&apos;t included, and attached
          files aren&apos;t shared, only their names. You can stop sharing at any time.
        </p>
        {error ? (
          <p role="alert" className="mt-4 text-[15px]">
            {error}
          </p>
        ) : null}
        <div className="mt-6 flex gap-3">
          <button type="button" className={SECONDARY} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={PRIMARY} disabled={!!busy} onClick={() => make("create")}>
            <GlassCode seed="create link" />
            <span>{busy ? "Creating…" : "Create link"}</span>
          </button>
        </div>
      </div>
    );
  }

  const when = new Date(share.updatedAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  return (
    <div>
      <p className="text-[16px] text-mute">
        Anyone with this link can read the chat as it was on {when}. Later messages aren&apos;t included unless you update it.
      </p>
      <input
        readOnly
        value={share.url}
        aria-label="Share link"
        data-testid="share-link"
        onFocus={(e) => e.currentTarget.select()}
        className="mt-4 h-12 w-full rounded-2xl bg-soft px-4 font-mono text-[14px] outline-none focus-visible:ring-1 focus-visible:ring-fg"
      />
      {error ? (
        <p role="alert" className="mt-4 text-[15px]">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex gap-3">
        <button
          type="button"
          className={PRIMARY}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(share.url);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              setError("Couldn't copy. Select the link and copy it yourself.");
            }
          }}
        >
          <GlassCode seed="copy link" />
          <span>{copied ? "Copied" : "Copy link"}</span>
        </button>
        {canShare ? (
          <button
            type="button"
            className={SECONDARY}
            onClick={() => navigator.share({ title: "Shared chat", url: share.url }).catch(() => {})}
          >
            Send…
          </button>
        ) : null}
      </div>
      <div className="mt-3 flex gap-3">
        <button type="button" className={SECONDARY} disabled={!!busy} onClick={() => make("update")}>
          {busy === "update" ? "Updating…" : "Update to now"}
        </button>
        <button
          type="button"
          className={SECONDARY}
          disabled={!!busy}
          onClick={async () => {
            setBusy("stop");
            setError(null);
            try {
              await stopSharing(chatId);
              setShare(null);
            } catch {
              setError("Couldn't stop sharing. Try again.");
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === "stop" ? "Stopping…" : "Stop sharing"}
        </button>
      </div>
    </div>
  );
}
