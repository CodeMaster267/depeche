"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { deleteGadget, removeShare, renameGadget, restoreVersion, setGadgetModel, shareGadget, takeShare } from "./actions";

/** A gadget someone shared: add a copy to My gadgets, or take it away. */
export function ShareRow({ id, title, from, mine = false, canRemove, label }: { id: string; title: string; from: string; mine?: boolean; canRemove: boolean; label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="flex flex-col gap-2 px-4 py-3" data-testid="share-row">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block truncate text-[17px]">{title}</span>
          <span className="block text-[13px] text-mute">From {from}</span>
        </span>
        <span className="flex gap-3 text-[14px]">
          {!mine ? (
            <button
              type="button"
              disabled={pending}
              className="press rounded-full bg-inv px-4 py-1.5 text-on-inv disabled:opacity-50"
              onClick={() =>
                start(async () => {
                  const r = await takeShare(id);
                  if (r.ok && r.id) router.push(`/gadgets/${r.id}`);
                  else if (!r.ok) setError(r.error);
                })
              }
            >
              Add to mine
            </button>
          ) : null}
          {canRemove ? (
            <button
              type="button"
              disabled={pending}
              className="press text-mute underline underline-offset-4"
              onClick={() =>
                start(async () => {
                  const r = await removeShare(id);
                  if (r.ok) router.refresh();
                  else setError(r.error);
                })
              }
            >
              {label}
            </button>
          ) : null}
        </span>
      </div>
      {error ? <p role="alert" className="text-[14px]">{error}</p> : null}
    </li>
  );
}

/** Change a gadget by asking: the request goes to the family's strongest model. */
export function ChangeForm({ id }: { id: string }) {
  const router = useRouter();
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!request.trim() || busy) return;
        setBusy(true);
        setNote(null);
        setError(null);
        try {
          const res = await fetch(`/api/gadgets/${id}/change`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request }) });
          const body = (await res.json().catch(() => ({}))) as { note?: string; error?: string; cost?: number; model?: string };
          const cost = typeof body.cost === "number" ? ` It cost ${(await import("@/lib/gadgets/cost")).costText(body.cost)}.` : "";
          if (res.ok) {
            setNote(`${body.note || "Changed."}${cost}`);
            setRequest("");
            router.refresh();
          } else setError(`${body.error ?? "Couldn't change it. Try again."}${cost}`);
        } catch {
          setError("Couldn't reach Depeche. Check your connection and try again.");
        }
        setBusy(false);
      }}
    >
      <textarea
        aria-label="What should change?"
        value={request}
        onChange={(e) => setRequest(e.target.value)}
        maxLength={2000}
        rows={3}
        placeholder="For example: make the board bigger, or add a timer"
        className="w-full resize-y rounded-2xl border border-line bg-bg px-4 py-3 text-[17px] leading-6 text-fg outline-none placeholder:text-faint focus:border-fg"
      />
      {busy ? <p role="status" className="text-[14px] text-mute">Changing it. This can take a minute.</p> : null}
      {note ? <p role="status" className="rounded-2xl bg-soft px-4 py-3 text-[15px]" data-testid="change-note">{note}</p> : null}
      {error ? <p role="alert" className="rounded-2xl border border-fg px-4 py-3 text-[15px]">{error}</p> : null}
      <Button type="submit" disabled={busy || !request.trim()}>{busy ? "Changing…" : "Change it"}</Button>
    </form>
  );
}

/** Which AI the gadget asks. */
export function ModelChoice({ id, model, models }: { id: string; model: string | null; models: { id: string; name: string }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <label className="flex flex-col gap-1.5 text-[15px]">
      <span className="text-mute">The AI this gadget asks</span>
      <select
        aria-label="The AI this gadget asks"
        disabled={pending}
        value={model ?? ""}
        onChange={(e) =>
          start(async () => {
            await setGadgetModel(id, e.target.value || null);
            router.refresh();
          })
        }
        className="h-11 rounded-2xl border border-line bg-bg px-3 text-fg"
      >
        <option value="">My usual model</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ShareForm({ id, people }: { id: string; people: { id: string; name: string }[] }) {
  const [to, setTo] = useState("family");
  const [pending, start] = useTransition();
  const [done, setDone] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <select aria-label="Share with" value={to} onChange={(e) => setTo(e.target.value)} className="h-11 rounded-2xl border border-line bg-bg px-3 text-fg">
        <option value="family">The whole family (the family shelf)</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await shareGadget(id, to);
            setDone(r.ok ? (to === "family" ? "On the family shelf." : `Sent to ${people.find((p) => p.id === to)?.name ?? "them"}.`) : r.error);
          })
        }
      >
        Share a copy
      </Button>
      {done ? <p role="status" className="text-[14px] text-mute">{done}</p> : null}
    </div>
  );
}

export function VersionButton({ id, versionId }: { id: string; versionId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      className="press text-[14px] underline underline-offset-4"
      onClick={() =>
        start(async () => {
          await restoreVersion(id, versionId);
          router.refresh();
        })
      }
    >
      Go back to this
    </button>
  );
}

export function GadgetSettings({ id, title }: { id: string; title: string }) {
  const router = useRouter();
  const [name, setName] = useState(title);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <input aria-label="Name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} className="h-11 min-w-0 flex-1 rounded-2xl border border-line bg-bg px-3 text-fg" />
        <Button variant="secondary" disabled={pending || !name.trim() || name === title} onClick={() => start(async () => { await renameGadget(id, name); router.refresh(); })}>
          Rename
        </Button>
      </div>
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            if (!confirm("Delete this gadget? Anything it remembers goes too.")) return;
            await deleteGadget(id);
            router.push("/gadgets");
          })
        }
      >
        Delete this gadget
      </Button>
    </div>
  );
}
