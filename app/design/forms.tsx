"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { build } from "@/components/design/DesignBrief";
import { setScheme, startPreview, useLookState } from "@/components/design/Look";
import type { Spec } from "@/lib/design/spec";
import { deleteDesign, resetDesign, setSafeMode } from "./actions";

export function BriefForm({ disabled, forId, forName, ideas }: { disabled: boolean; forId?: string; forName?: string; ideas: string[] }) {
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!brief.trim() || busy) return;
        setBusy(true);
        setError(null);
        setDone(null);
        const r = await build(brief.trim(), forId, forName);
        setBusy(false);
        if (r.ok) {
          setDone(
            forId
              ? `Built by ${r.reply.model}. ${forName} gets Keep or Undo the next time they open Depeche.`
              : `Built by ${r.reply.model}. Keep it or undo it at the top of the screen.`,
          );
        } else setError(r.error);
      }}
    >
      <label className="flex flex-col gap-1.5">
        <span className="sr-only">Describe the look</span>
        <textarea
          aria-label="Describe the look"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          maxLength={2000}
          rows={4}
          placeholder={forName ? `For example: bigger text and high contrast for ${forName}` : "For example: playful, colourful and rounded, with the chats on the right"}
          className="w-full resize-y rounded-2xl border border-line bg-bg px-4 py-3 text-[17px] leading-6 text-fg outline-none placeholder:text-faint focus:border-fg"
        />
      </label>
      {ideas.length ? (
        <div className="flex flex-wrap gap-2" aria-label="Ideas">
          {ideas.map((idea) => (
            <button
              key={idea}
              type="button"
              className="press rounded-full border border-line px-3 py-1.5 text-left text-[13px] text-mute hover:text-fg"
              onClick={() => setBrief(idea)}
            >
              {idea}
            </button>
          ))}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-2xl border border-fg px-4 py-3 text-[15px]">
          {error}
        </p>
      ) : null}
      {done ? (
        <p role="status" className="rounded-2xl bg-soft px-4 py-3 text-[15px]">
          {done}
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="text-[14px] text-mute">
          The designer is working on it. This can take a minute or two.
        </p>
      ) : null}
      <Button type="submit" disabled={disabled || busy || !brief.trim()} data-busy={busy ? "" : undefined}>
        {busy ? "Designing…" : forName ? `Build ${forName}'s look` : "Build my look"}
      </Button>
    </form>
  );
}

export function HistoryButtons({ id, spec }: { id: string; spec: Spec }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <span className="flex gap-4 text-[14px]">
      <button
        type="button"
        className="press underline underline-offset-4"
        onClick={() => {
          startPreview({ id, spec, kind: "history" });
          window.scrollTo({ top: 0 });
        }}
      >
        Try it again
      </button>
      <button
        type="button"
        disabled={pending}
        className="press text-mute underline underline-offset-4"
        onClick={() =>
          start(async () => {
            await deleteDesign(id);
            router.refresh();
          })
        }
      >
        Delete
      </button>
    </span>
  );
}

export function ResetButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      variant="secondary"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await resetDesign();
          router.refresh();
        })
      }
    >
      Back to standard Depeche
    </Button>
  );
}

export function SafeModeToggle({ on }: { on: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      variant="secondary"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await setSafeMode(!on);
          router.refresh();
        })
      }
    >
      {on ? "Turn safe mode off" : "Turn safe mode on"}
    </Button>
  );
}

/** Light, dark or the device's setting, for this device. Also what the light-or-dark button changes. */
export function LightDarkChoice() {
  const { scheme } = useLookState();
  const options = [
    ["auto", "Follow this device"],
    ["light", "Always light"],
    ["dark", "Always dark"],
  ] as const;
  return (
    <div role="radiogroup" aria-label="Light or dark on this device" className="flex flex-wrap gap-2">
      {options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={scheme === value}
          className={`press rounded-full border px-4 py-2 text-[14px] ${scheme === value ? "border-inv bg-inv text-on-inv" : "border-line"}`}
          onClick={() => setScheme(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
