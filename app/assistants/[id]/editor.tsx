"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { GlassCode } from "@/components/Glass";
import { Notice } from "@/components/ui";
import { findModel } from "@/lib/ai/models";
import { sizeLabel } from "@/lib/chat/files";
import {
  MAX_ASSISTANT_DESCRIPTION,
  MAX_ASSISTANT_FILES,
  MAX_ASSISTANT_INSTRUCTIONS,
  MAX_ASSISTANT_NAME,
  cleanAssistantName,
  type AssistantDetail,
} from "@/lib/chat/assistants";
import { ContextFiles } from "@/components/chat/Projects";
import { FileIcon } from "@/components/chat/icons";
import { addAssistantFile, deleteAssistant, removeAssistantFile, saveAssistant } from "../actions";

const box = "w-full rounded-2xl border border-line bg-bg px-4 text-[17px] outline-none placeholder:text-faint focus:border-fg";

function ChatLink({ id, name }: { id: string; name: string }) {
  return (
    <Link
      href={`/?assistant=${id}`}
      className="press glass glass-pill inline-flex h-14 w-full items-center justify-center gap-3 rounded-2xl px-5 text-[17px] font-semibold"
    >
      <GlassCode seed={`chat ${name}`} />
      <span>Chat with {name}</span>
    </Link>
  );
}

/**
 * Make or change an assistant. Someone else's shared assistant is shown read-only, so the family
 * can see what it's been told before chatting with it.
 */
export function AssistantEditor({ userId, assistant, modelIds }: { userId: string; assistant: AssistantDetail | null; modelIds: string[] }) {
  const router = useRouter();
  const [name, setName] = useState(assistant?.name ?? "");
  const [description, setDescription] = useState(assistant?.description ?? "");
  const [instructions, setInstructions] = useState(assistant?.instructions ?? "");
  const [model, setModel] = useState<string>(assistant?.model ?? "");
  const [shared, setShared] = useState(assistant?.shared ?? false);
  const [files, setFiles] = useState(assistant?.files ?? []);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);

  if (assistant && !assistant.mine) {
    return (
      <div className="flex flex-col gap-6 pt-4">
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-semibold uppercase tracking-[0.08em] text-mute">Shared by your family</span>
          <h1 className="break-words text-[34px] font-semibold tracking-tight">{assistant.name}</h1>
          {assistant.description ? <p className="text-[16px] text-mute">{assistant.description}</p> : null}
        </div>
        <ChatLink id={assistant.id} name={assistant.name} />
        <section className="flex flex-col gap-2">
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-mute">Instructions</h2>
          <p className="whitespace-pre-wrap break-words text-[16px]" data-testid="assistant-instructions">
            {assistant.instructions || "None"}
          </p>
        </section>
        {findModel(assistant.model) ? (
          <p className="text-[15px] text-mute">Starts with {findModel(assistant.model)!.name}.</p>
        ) : null}
        {assistant.files.length ? (
          <section className="flex flex-col gap-2">
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-mute">Files it knows</h2>
            <ul className="flex flex-col gap-2">
              {assistant.files.map((f) => (
                <li key={f.id} className="flex items-center gap-3 rounded-2xl bg-soft px-3 py-2.5">
                  <FileIcon className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-[15px]">{f.name}</span>
                  <span className="text-[12px] text-mute">{sizeLabel(f.size)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    );
  }

  const clean = cleanAssistantName(name);
  const save = async () => {
    if (!clean || busy) return;
    setBusy(true);
    setNote(null);
    const res = await saveAssistant(assistant?.id ?? null, { name, description, instructions, model: model || null, shared }).catch(() => ({
      error: "Couldn't save. Try again.",
    }));
    setBusy(false);
    if ("error" in res) setNote({ tone: "error", text: res.error });
    else if (!assistant) router.replace(`/assistants/${res.id}`);
    else setNote({ tone: "info", text: "Saved." });
  };

  return (
    <form
      className="flex flex-col gap-6 pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <h1 className="text-[34px] font-semibold tracking-tight">{assistant ? "Edit assistant" : "New assistant"}</h1>
      {assistant ? <ChatLink id={assistant.id} name={assistant.name} /> : null}
      <label className="flex flex-col gap-2">
        <span className="text-[15px] font-medium">Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={MAX_ASSISTANT_NAME}
          aria-label="Name"
          placeholder="For example: Homework helper"
          className={`${box} h-14`}
        />
      </label>
      <label className="flex flex-col gap-2">
        <span className="text-[15px] font-medium">What it&apos;s for</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={MAX_ASSISTANT_DESCRIPTION}
          aria-label="What it's for"
          placeholder="One line, shown in the list"
          className={`${box} h-14`}
        />
      </label>
      <label className="flex flex-col gap-2">
        <span className="text-[15px] font-medium">Instructions</span>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          maxLength={MAX_ASSISTANT_INSTRUCTIONS}
          rows={8}
          aria-label="Instructions"
          placeholder="For example: Help with school homework. Guide step by step and ask questions back; don't just give the answer."
          className={`${box} resize-y py-3 leading-6`}
        />
        <span className="text-right font-mono text-[12px] text-mute">
          {instructions.length} / {MAX_ASSISTANT_INSTRUCTIONS}
        </span>
      </label>
      <label className="flex flex-col gap-2">
        <span className="text-[15px] font-medium">Model</span>
        <select aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)} className={`${box} h-14 appearance-none`}>
          <option value="">Whichever model is picked in the chat</option>
          {modelIds.map((id) => (
            <option key={id} value={id}>
              {findModel(id)?.name ?? id}
            </option>
          ))}
          {model && !modelIds.includes(model) ? <option value={model}>{findModel(model)?.name ?? model} (not available now)</option> : null}
        </select>
      </label>
      <label className="flex items-start gap-3 rounded-2xl border border-line px-4 py-3.5">
        <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} className="mt-1 h-5 w-5 accent-current" />
        <span className="flex flex-col gap-0.5">
          <span className="text-[16px] font-medium">Share with my family</span>
          <span className="text-[14px] text-mute">
            Everyone in your family can see its name, instructions and file names, and chat with it. Only you can change it. Their chats
            with it stay private to them.
          </span>
        </span>
      </label>
      {note ? <Notice tone={note.tone}>{note.text}</Notice> : null}
      <button
        type="submit"
        disabled={!clean || busy}
        className="press glass glass-pill inline-flex h-14 w-full items-center justify-center gap-3 rounded-2xl px-5 text-[17px] font-semibold disabled:opacity-50"
      >
        <GlassCode seed="save assistant" />
        <span>{busy ? "Saving…" : assistant ? "Save" : "Create"}</span>
      </button>

      {assistant ? (
        <section className="rounded-[22px] border border-line p-4" aria-label="Files">
          <ContextFiles
            userId={userId}
            files={files}
            max={MAX_ASSISTANT_FILES}
            hint="Reference material it reads in every chat: photos, PDFs, Word, Excel, PowerPoint and text files."
            testId="assistant-file"
            onAdd={(ref) => addAssistantFile(assistant.id, ref)}
            onRemove={(id) => removeAssistantFile(id)}
            onChange={setFiles}
          />
        </section>
      ) : (
        <p className="text-[14px] text-mute">You can add files once it&apos;s created.</p>
      )}

      {assistant ? (
        confirming ? (
          <div className="flex flex-col gap-3 rounded-2xl border border-fg p-4" role="alertdialog" aria-label="Delete assistant">
            <p className="text-[15px]">Delete {assistant.name} and its files? Chats already made with it are kept.</p>
            <div className="flex gap-3">
              <button type="button" className="press h-12 flex-1 rounded-full border border-line text-[16px]" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="press h-12 flex-1 rounded-full bg-inv text-[16px] font-medium text-on-inv"
                onClick={async () => {
                  await deleteAssistant(assistant.id).catch(() => {});
                  router.push("/assistants");
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="self-start text-[15px] text-mute underline underline-offset-4" onClick={() => setConfirming(true)}>
            Delete assistant
          </button>
        )
      ) : null}
    </form>
  );
}
