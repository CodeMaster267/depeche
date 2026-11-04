"use client";

import { useEffect, useRef, useState } from "react";
import { deletePrompt, listPrompts, savePrompt } from "@/app/c/prompts";
import { PROMPT_BODY_MAX, PROMPT_TITLE_MAX, blanksIn, fillBlanks, type SavedPrompt } from "@/lib/chat/prompts";
import { CloseIcon, SearchIcon } from "./icons";

type View = { kind: "list" } | { kind: "edit"; prompt?: SavedPrompt; body?: string } | { kind: "fill"; prompt: SavedPrompt };

/**
 * Saved prompts: a sheet from the bottom on phones, a panel on larger screens. Picking one puts it
 * in the message box; one with {{blanks}} asks for them first.
 */
export function SavedPrompts({ draft, onUse, onClose }: { draft: string; onUse: (text: string) => void; onClose: () => void }) {
  const [prompts, setPrompts] = useState<SavedPrompt[] | null>(null);
  const [view, setView] = useState<View>({ kind: "list" });
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listPrompts()
      .then(setPrompts)
      .catch(() => {
        setPrompts([]);
        setError("Couldn't load your prompts. Try again.");
      });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    panel.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const use = (p: SavedPrompt) => (blanksIn(p.body).length ? setView({ kind: "fill", prompt: p }) : onUse(p.body));
  const needle = q.trim().toLowerCase();
  const shown = (prompts ?? []).filter((p) => !needle || `${p.title} ${p.body}`.toLowerCase().includes(needle));
  const title = view.kind === "list" ? "Saved prompts" : view.kind === "fill" ? view.prompt.title : view.prompt ? "Edit prompt" : "New prompt";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-start sm:pt-[12vh]" role="presentation">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="enter-glitch relative flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-t-[28px] bg-bg outline-none sm:max-w-[520px] sm:rounded-[24px] sm:border sm:border-line"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-line sm:hidden" />
        <div className="flex items-center justify-between gap-3 px-6 pb-3 pt-4">
          {view.kind !== "list" ? (
            <button type="button" className="-ml-2 p-2 text-[16px] text-mute" onClick={() => (setError(null), setView({ kind: "list" }))}>
              Back
            </button>
          ) : null}
          <h2 className="min-w-0 flex-1 truncate text-[26px] font-semibold tracking-tight">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 p-2 text-mute">
            <CloseIcon />
          </button>
        </div>
        {error ? (
          <p role="alert" className="mx-6 mb-3 rounded-2xl border border-fg px-4 py-3 text-[15px]">
            {error}
          </p>
        ) : null}

        {view.kind === "list" ? (
          <>
            {(prompts?.length ?? 0) > 5 ? (
              <label className="mx-6 mb-2 flex h-12 items-center gap-2 rounded-2xl bg-soft px-4 text-mute">
                <SearchIcon />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search prompts"
                  aria-label="Search prompts"
                  className="h-full w-full bg-transparent text-[17px] text-fg outline-none placeholder:text-faint"
                />
              </label>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {prompts === null ? <p className="px-6 py-4 text-[15px] text-mute">Loading…</p> : null}
              {prompts?.length === 0 ? (
                <p className="px-6 pb-4 text-[15px] leading-relaxed text-mute">
                  Save messages you send often. Put a word in double curly brackets, like {"{{topic}}"}, and you&apos;ll be asked to fill
                  it in each time.
                </p>
              ) : null}
              <ul>
                {shown.map((p) => (
                  <li key={p.id} className="flex items-stretch border-b border-line">
                    <button type="button" className="min-w-0 flex-1 px-6 py-3.5 text-left" onClick={() => use(p)}>
                      <span className="block truncate text-[17px]">{p.title}</span>
                      <span className="mt-0.5 block truncate text-[14px] text-mute">{p.body}</span>
                    </button>
                    <button
                      type="button"
                      className="shrink-0 px-5 text-[15px] text-mute hover:text-fg"
                      aria-label={`Edit ${p.title}`}
                      onClick={() => setView({ kind: "edit", prompt: p })}
                    >
                      Edit
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex flex-wrap gap-2 px-6 py-4">
              <button type="button" className="press glass rounded-full px-5 py-2.5 text-[16px]" onClick={() => setView({ kind: "edit" })}>
                New prompt
              </button>
              {draft.trim() ? (
                <button
                  type="button"
                  className="press rounded-full border border-line px-5 py-2.5 text-[16px]"
                  onClick={() => setView({ kind: "edit", body: draft.trim() })}
                >
                  Save what I typed
                </button>
              ) : null}
            </div>
          </>
        ) : view.kind === "edit" ? (
          <PromptForm
            key={view.prompt?.id ?? "new"}
            prompt={view.prompt}
            body={view.body}
            onSaved={(p) => {
              setError(null);
              setPrompts((list) => [p, ...(list ?? []).filter((x) => x.id !== p.id)]);
              setView({ kind: "list" });
            }}
            onDeleted={(id) => {
              setPrompts((list) => (list ?? []).filter((x) => x.id !== id));
              setView({ kind: "list" });
            }}
            onError={setError}
          />
        ) : (
          <FillForm prompt={view.prompt} onUse={onUse} />
        )}
      </div>
    </div>
  );
}

function PromptForm({
  prompt,
  body: initialBody,
  onSaved,
  onDeleted,
  onError,
}: {
  prompt?: SavedPrompt;
  body?: string;
  onSaved: (p: SavedPrompt) => void;
  onDeleted: (id: string) => void;
  onError: (e: string) => void;
}) {
  const [title, setTitle] = useState(prompt?.title ?? "");
  const [body, setBody] = useState(prompt?.body ?? initialBody ?? "");
  const [saving, setSaving] = useState(false);
  const blanks = blanksIn(body);
  return (
    <form
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pb-5"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!body.trim() || saving) return;
        setSaving(true);
        const res = await savePrompt({ id: prompt?.id, title, body }).catch(() => ({ error: "Couldn't save that prompt. Try again." }) as const);
        setSaving(false);
        if ("prompt" in res && res.prompt) onSaved(res.prompt);
        else onError(res.error ?? "Couldn't save that prompt. Try again.");
      }}
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-[14px] text-mute">Name</span>
        <input
          value={title}
          aria-label="Name"
          maxLength={PROMPT_TITLE_MAX}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Optional"
          className="h-12 rounded-2xl border border-line bg-transparent px-4 text-[17px] outline-none focus:border-fg"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[14px] text-mute">Prompt</span>
        <textarea
          value={body}
          aria-label="Prompt"
          maxLength={PROMPT_BODY_MAX}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          placeholder="Translate {{text}} into {{language}}"
          className="min-h-[140px] resize-y rounded-2xl border border-line bg-transparent px-4 py-3 text-[17px] leading-6 outline-none focus:border-fg"
        />
      </label>
      <p className="text-[14px] leading-relaxed text-mute">
        {blanks.length
          ? `You'll be asked for: ${blanks.join(", ")}.`
          : "Tip: put a word in double curly brackets, like {{topic}}, to fill it in each time."}
      </p>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button type="submit" disabled={!body.trim() || saving} className="press glass rounded-full px-6 py-2.5 text-[16px] disabled:opacity-40">
          {saving ? "Saving…" : "Save"}
        </button>
        {prompt ? (
          <button
            type="button"
            className="press rounded-full px-4 py-2.5 text-[16px] text-mute hover:text-fg"
            onClick={async () => {
              if (!window.confirm(`Delete "${prompt.title}"?`)) return;
              await deletePrompt(prompt.id).catch(() => {});
              onDeleted(prompt.id);
            }}
          >
            Delete
          </button>
        ) : null}
      </div>
    </form>
  );
}

function FillForm({ prompt, onUse }: { prompt: SavedPrompt; onUse: (text: string) => void }) {
  const blanks = blanksIn(prompt.body);
  const [values, setValues] = useState<Record<string, string>>({});
  const first = useRef<HTMLTextAreaElement>(null);
  useEffect(() => first.current?.focus(), []);
  return (
    <form
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pb-5"
      onSubmit={(e) => {
        e.preventDefault();
        onUse(fillBlanks(prompt.body, values));
      }}
    >
      {blanks.map((b, i) => (
        <label key={b} className="flex flex-col gap-1.5">
          <span className="text-[14px] text-mute">{b}</span>
          <textarea
            ref={i === 0 ? first : undefined}
            rows={1}
            aria-label={b}
            value={values[b] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [b]: e.target.value }))}
            className="min-h-12 resize-y rounded-2xl border border-line bg-transparent px-4 py-3 text-[17px] leading-6 outline-none focus:border-fg"
          />
        </label>
      ))}
      <p className="whitespace-pre-wrap break-words rounded-2xl bg-soft px-4 py-3 text-[15px] leading-relaxed text-mute">{fillBlanks(prompt.body, values)}</p>
      <div className="pt-1">
        <button type="submit" className="press glass rounded-full px-6 py-2.5 text-[16px]">
          Put in message
        </button>
      </div>
    </form>
  );
}
