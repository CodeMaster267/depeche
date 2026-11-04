"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { startPreview } from "./Look";
import type { Spec } from "@/lib/design/spec";

type Meter = { used: number; allowed: number; enabled?: boolean };

/** "3 of 10 builds used this month". */
export function meterText(m: Meter): string {
  const left = Math.max(0, m.allowed - m.used);
  return `${m.used} of ${m.allowed} design build${m.allowed === 1 ? "" : "s"} used this month · ${left} left`;
}

export type BuildReply = { design: { id: string; spec: Spec }; offered: boolean; unmet: string[]; adjusted: boolean; model: string } & Meter;

/**
 * Sends a brief to be built, and shows the result straight away with Keep or Undo. `forId` and
 * `forName` are set when a family admin designs for someone else.
 */
export async function build(brief: string, forId?: string, forName?: string): Promise<{ ok: true; reply: BuildReply } | { ok: false; error: string; meter?: Meter }> {
  try {
    const res = await fetch("/api/design/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brief, ...(forId ? { for: forId } : {}) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error ?? "Couldn't build that. Try again; failed builds don't count.", meter: typeof body.used === "number" ? body : undefined };
    const reply = body as BuildReply;
    startPreview({
      id: reply.design.id,
      spec: reply.design.spec,
      kind: reply.offered ? "for" : "own",
      forName,
      unmet: reply.unmet,
      adjusted: reply.adjusted,
    });
    return { ok: true, reply };
  } catch {
    return { ok: false, error: "Couldn't reach Depeche. Check your connection and try again; failed builds don't count." };
  }
}

// One request for the meter shared by every card that appears at once (a reply's card is redrawn
// when the reply is saved), instead of one each.
let shared: { at: number; meter: Promise<Meter | null> } | null = null;
function fetchMeter(): Promise<Meter | null> {
  if (!shared || Date.now() - shared.at > 5_000) {
    shared = {
      at: Date.now(),
      meter: fetch("/api/design/build")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    };
  }
  return shared.meter;
}

export function useMeter(skip = false) {
  const [meter, setMeter] = useState<Meter | null>(null);
  useEffect(() => {
    if (skip) return;
    let live = true;
    fetchMeter().then((m) => live && m && setMeter(m));
    return () => {
      live = false;
    };
  }, [skip]);
  return [meter, setMeter] as const;
}

/** A ```design block in a reply: the brief the assistant wrote, with Build. */
export function DesignBrief({ brief, streaming }: { brief: string; streaming: boolean }) {
  const [meter, setMeter] = useMeter(streaming);
  const [state, setState] = useState<"idle" | "building" | "built">("idle");
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const text = brief.trim();
  const out = meter && meter.used >= meter.allowed;
  const off = meter?.enabled === false;

  return (
    <div className="md-file flex flex-col gap-3" data-testid="design-brief">
      <div className="flex items-center gap-3">
        <span aria-hidden className="md-file-icon">LOOK</span>
        <div className="min-w-0">
          <p className="text-[15px] font-semibold">A new look for your Depeche</p>
          <p className="text-[13px] text-mute">Only you see it. You can keep it or undo it.</p>
        </div>
      </div>
      <p className="whitespace-pre-wrap rounded-xl bg-soft px-3 py-2.5 text-[15px] leading-relaxed">{text}</p>
      {!streaming ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-[13px] text-mute" data-testid="design-meter">
            {off ? "Your family admin has turned off redesigns for now." : meter ? meterText(meter) : " "}
          </span>
          <button
            type="button"
            disabled={state === "building" || !text || out || off}
            data-busy={state === "building" ? "" : undefined}
            className="press glass glass-pill flex h-11 items-center justify-center px-5 text-[15px] font-semibold disabled:opacity-50"
            onClick={async () => {
              setState("building");
              setError(null);
              const r = await build(text);
              if (r.ok) {
                setState("built");
                setModel(r.reply.model);
                setMeter(r.reply);
              } else {
                setState("idle");
                setError(r.error);
                if (r.meter) setMeter(r.meter);
              }
            }}
          >
            <span>{state === "building" ? "Designing…" : state === "built" ? "Build again" : "Build this look"}</span>
          </button>
        </div>
      ) : null}
      {state === "building" ? (
        <p role="status" className="text-[13px] text-mute">
          The designer is working on it. This can take a minute or two.
        </p>
      ) : null}
      {state === "built" ? (
        <p role="status" className="text-[13px] text-mute">
          Built{model ? ` by ${model}` : ""}. Keep it or undo it at the top of the screen. Older looks are in{" "}
          <Link href="/design" className="underline underline-offset-4">
            My look
          </Link>
          .
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-xl border border-fg px-3 py-2 text-[14px]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
