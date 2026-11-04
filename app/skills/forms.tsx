"use client";

import Link from "next/link";
import { useActionState, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Notice } from "@/components/ui";
import { MAX_BRIEF, MAX_DESCRIPTION, MAX_FILE_CHARS, MAX_FILES, MAX_INSTRUCTIONS, type SkillFile } from "@/lib/skills/skill";
import { addToMine, deleteSkill, removeFromLibrary, removeFromMine } from "./actions";

const BOX = "rounded-2xl border border-line bg-bg px-4 py-3 text-[17px] outline-none placeholder:text-faint focus:border-fg";

/** Sends a request to the skills API and returns its JSON, or an error a person can read. */
type Saved = { id: string; name: string; description: string; instructions: string; files: SkillFile[]; triggers: string[] };

async function call(url: string, method: string, body: object): Promise<{ skill?: Saved; error?: string }> {
  try {
    const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as { skill?: Saved; error?: string };
    if (!res.ok) return { error: json.error ?? "Something went wrong. Try again." };
    return json;
  } catch {
    return { error: "Couldn't reach Depeche. Check your connection and try again." };
  }
}

/** Describe a skill; a model writes and names it, it's checked, and you're taken to it. */
export function NewSkillForm({ ideas }: { ideas: string[] }) {
  const router = useRouter();
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const out = await call("/api/skills", "POST", { brief });
    if (out.skill) router.push(`/skills/${out.skill.id}?made=1`);
    else {
      setError(out.error ?? "Something went wrong. Try again.");
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" data-testid="new-skill">
      <label className="flex flex-col gap-2">
        <span className="text-[15px] font-medium">What should the skill help with?</span>
        <textarea
          name="brief"
          rows={3}
          maxLength={MAX_BRIEF}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder={ideas[0]}
          className={`resize-none ${BOX}`}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        {ideas.slice(1).map((idea) => (
          <button key={idea} type="button" onClick={() => setBrief(idea)} className="press rounded-full border border-line px-3 py-1.5 text-left text-[14px] text-mute hover:text-fg">
            {idea}
          </button>
        ))}
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {busy ? <Notice>Writing and checking your skill. This can take up to a minute.</Notice> : null}
      <Button type="submit" disabled={busy || brief.trim().length < 8} aria-busy={busy || undefined}>
        {busy ? "Writing…" : "Make skill"}
      </Button>
      <p className="text-[13px] text-mute">Uses your family&apos;s AI keys and counts toward your monthly limit, usually a cent or two.</p>
    </form>
  );
}

export type LibraryItem = { id: string; name: string; description: string; by: string; mine: boolean };

/** A list of skills with Add and Remove, and a search box for the whole library. */
export function Library({ items, search = false, testId }: { items: LibraryItem[]; search?: boolean; testId: string }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return items;
    return items.filter((s) => s.name.includes(t.replace(/\s+/g, "-")) || s.description.toLowerCase().includes(t));
  }, [items, q]);
  return (
    <div className="flex flex-col gap-3">
      {search ? (
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search skills"
          aria-label="Search skills"
          className={`h-12 ${BOX} py-0`}
        />
      ) : null}
      <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line" data-testid={testId}>
        {shown.map((s) => (
          <li key={s.id} className="flex items-start justify-between gap-4 px-4 py-3.5">
            <span className="min-w-0">
              <Link href={`/skills/${s.id}`} className="block break-words font-mono text-[15px] font-medium underline-offset-4 hover:underline">
                {s.name}
              </Link>
              <span className="mt-0.5 block text-[15px] leading-snug text-mute">{s.description}</span>
              <span className="mt-1 block text-[13px] text-faint">by {s.by}</span>
            </span>
            <PickButton id={s.id} mine={s.mine} name={s.name} />
          </li>
        ))}
        {!shown.length ? <li className="px-4 py-3.5 text-[15px] text-mute">No skills match.</li> : null}
      </ul>
    </div>
  );
}

/** Add to, or remove from, your own skills. */
export function PickButton({ id, mine, name, big = false }: { id: string; mine: boolean; name: string; big?: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const onClick = () =>
    start(async () => {
      const out = mine ? await removeFromMine(id) : await addToMine(id);
      setError(out?.error ?? null);
    });
  return (
    <span className={`flex flex-col ${big ? "items-stretch" : "shrink-0 items-end"} gap-1`}>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        aria-label={`${mine ? "Remove" : "Add"} ${name}`}
        className={`press rounded-full px-4 text-[15px] font-medium disabled:opacity-50 ${big ? "h-12" : "h-9"} ${mine ? "border border-line text-mute" : "bg-inv text-on-inv"}`}
      >
        {mine ? "Remove" : "Add"}
      </button>
      {error ? <span role="alert" className="text-[13px]">{error}</span> : null}
    </span>
  );
}

type Editable = { id: string; description: string; instructions: string; files: SkillFile[]; triggers: string[] };

/** For the person who made the skill: change it by asking, edit it yourself, or delete it. */
export function SkillEditor({ skill }: { skill: Editable }) {
  const router = useRouter();
  const [mode, setMode] = useState<"ask" | "edit">("ask");
  const [ask, setAsk] = useState("");
  const [description, setDescription] = useState(skill.description);
  const [instructions, setInstructions] = useState(skill.instructions);
  const [files, setFiles] = useState<SkillFile[]>(skill.files);
  const [triggers, setTriggers] = useState(skill.triggers.join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setOk(null);
    const out =
      mode === "ask"
        ? await call(`/api/skills/${skill.id}`, "POST", { ask })
        : await call(`/api/skills/${skill.id}`, "PATCH", { description, instructions, files, triggers });
    setBusy(false);
    if (out.error) return setError(out.error);
    if (out.skill) {
      // The fields show the version just saved (the model may have rewritten all of it).
      setDescription(out.skill.description);
      setInstructions(out.skill.instructions);
      setFiles(out.skill.files);
      setTriggers(out.skill.triggers.join(", "));
    }
    setOk("Saved. Everyone who added this skill now gets the new version.");
    setAsk("");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4" data-testid="skill-editor">
      <div role="tablist" className="flex gap-2">
        {(["ask", "edit"] as const).map((m) => (
          <button
            key={m}
            role="tab"
            type="button"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={`press h-10 rounded-full px-4 text-[15px] ${mode === m ? "bg-inv text-on-inv" : "border border-line text-mute"}`}
          >
            {m === "ask" ? "Change by asking" : "Edit it yourself"}
          </button>
        ))}
      </div>
      <form onSubmit={send} className="flex flex-col gap-3">
        {mode === "ask" ? (
          <label className="flex flex-col gap-2">
            <span className="text-[15px] font-medium">What should change?</span>
            <textarea rows={3} maxLength={MAX_BRIEF} value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="For example: also cover school uniform costs." className={`resize-none ${BOX}`} />
          </label>
        ) : (
          <>
            <label className="flex flex-col gap-2">
              <span className="text-[15px] font-medium">Description</span>
              <textarea rows={2} maxLength={MAX_DESCRIPTION} value={description} onChange={(e) => setDescription(e.target.value)} className={`resize-none ${BOX}`} />
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-[15px] font-medium">Instructions</span>
              <textarea rows={12} maxLength={MAX_INSTRUCTIONS} value={instructions} onChange={(e) => setInstructions(e.target.value)} className={`${BOX} font-mono text-[15px]`} />
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-[15px] font-medium">Picked up when a message mentions</span>
              <input value={triggers} onChange={(e) => setTriggers(e.target.value)} className={`h-12 ${BOX} py-0`} placeholder="budget, bills, savings" />
            </label>
            {files.map((f, i) => (
              <div key={i} className="flex flex-col gap-2 rounded-2xl border border-line p-3">
                <div className="flex items-center gap-2">
                  <input
                    aria-label={`File ${i + 1} name`}
                    value={f.name}
                    onChange={(e) => setFiles(files.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    className="h-10 min-w-0 flex-1 rounded-xl border border-line bg-bg px-3 font-mono text-[15px] outline-none focus:border-fg"
                  />
                  <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} className="text-[15px] text-mute underline underline-offset-4">
                    Remove file
                  </button>
                </div>
                <textarea
                  aria-label={`File ${i + 1} text`}
                  rows={5}
                  maxLength={MAX_FILE_CHARS}
                  value={f.content}
                  onChange={(e) => setFiles(files.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))}
                  className="rounded-xl border border-line bg-bg px-3 py-2 font-mono text-[14px] outline-none focus:border-fg"
                />
              </div>
            ))}
            {files.length < MAX_FILES ? (
              <button type="button" onClick={() => setFiles([...files, { name: "notes.md", content: "" }])} className="self-start text-[15px] text-mute underline underline-offset-4">
                Add a file
              </button>
            ) : null}
          </>
        )}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {ok ? <Notice>{ok}</Notice> : null}
        {busy ? <Notice>{mode === "ask" ? "Rewriting and checking the skill…" : "Checking the skill…"}</Notice> : null}
        <Button type="submit" disabled={busy || (mode === "ask" && ask.trim().length < 4)}>
          {busy ? "Saving…" : mode === "ask" ? "Change skill" : "Save changes"}
        </Button>
        <p className="text-[13px] text-mute">Every change is checked for safety before it&apos;s saved. The name stays the one the model chose.</p>
      </form>
    </div>
  );
}

export function DeleteSkillButton({ id }: { id: string }) {
  return (
    <form
      action={deleteSkill.bind(null, id)}
      onSubmit={(e) => {
        if (!confirm("Delete this skill for everyone who added it? This can't be undone.")) e.preventDefault();
      }}
    >
      <button type="submit" className="text-[15px] text-mute underline underline-offset-4">
        Delete skill
      </button>
    </form>
  );
}

/** For the app owner, or an admin of the family that made it. */
export function RemoveFromLibraryForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState(removeFromLibrary.bind(null, id), undefined);
  return (
    <form
      action={action}
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        if (!confirm("Take this skill out of the library for everyone?")) e.preventDefault();
      }}
    >
      <label className="flex flex-col gap-2">
        <span className="text-[15px] font-medium">Why (shown to the person who made it)</span>
        <input name="note" maxLength={300} className={`h-12 ${BOX} py-0`} placeholder="Optional" />
      </label>
      {state?.error ? <Notice tone="error">{state.error}</Notice> : state?.ok ? <Notice>{state.ok}</Notice> : null}
      <Button variant="secondary" disabled={pending}>Remove from library</Button>
    </form>
  );
}
