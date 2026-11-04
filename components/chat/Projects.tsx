"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { GlassCode } from "@/components/Glass";
import { addProjectFile, deleteProject, removeProjectFile, renameProject, saveInstructions } from "@/app/p/actions";
import { MAX_PROJECT_FILES, MAX_PROJECT_INSTRUCTIONS, cleanProjectName, type ProjectDetail, type ProjectFile } from "@/lib/chat/projects";
import { refusal, sizeLabel, storedType, type FileRef } from "@/lib/chat/files";
import type { ChatRow } from "@/lib/chat/thread";
import { ACCEPT, uploadFile } from "./Attachments";
import { ChatMenu, Sheet } from "./ChatMenu";
import { useProjects } from "./projects-context";
import { CloseIcon, FileIcon, FolderIcon, PlusIcon } from "./icons";

const input =
  "h-12 w-full rounded-2xl bg-soft px-4 text-[17px] outline-none placeholder:text-faint focus-visible:ring-1 focus-visible:ring-fg";

function SheetButtons({ onCancel, label, busy, disabled }: { onCancel: () => void; label: string; busy?: boolean; disabled?: boolean }) {
  return (
    <div className="mt-6 flex gap-3">
      <button type="button" className="press h-12 flex-1 rounded-full border border-line text-[16px]" onClick={onCancel}>
        Cancel
      </button>
      <button
        type="submit"
        disabled={disabled || busy}
        className="press glass glass-pill flex h-12 flex-1 items-center justify-center text-[16px] font-medium disabled:opacity-50"
      >
        <GlassCode seed={label} />
        <span>{busy ? "Saving…" : label}</span>
      </button>
    </div>
  );
}

/** Name a new project, then open it. */
export function NewProjectSheet({ onClose, onCreated }: { onClose: () => void; onCreated?: () => void }) {
  const router = useRouter();
  const projects = useProjects();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = cleanProjectName(name);
  return (
    <Sheet label="New project" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!clean || busy || !projects) return;
          setBusy(true);
          const made = await projects.create(clean).catch(() => null);
          setBusy(false);
          if (!made) {
            setError("Couldn't make the project. Try again.");
            return;
          }
          onClose();
          onCreated?.();
          router.push(`/p/${made.id}`);
        }}
      >
        <p className="mb-4 text-[15px] text-mute">
          Keep related chats together. A project can have its own instructions and files that every chat in it can use.
        </p>
        <input
          autoFocus
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          aria-label="Project name"
          placeholder="For example: Chemistry, Wedding, Work"
          enterKeyHint="done"
          className={input}
        />
        {error ? (
          <p role="alert" className="mt-3 text-[15px]">
            {error}
          </p>
        ) : null}
        <SheetButtons onCancel={onClose} label="Create" busy={busy} disabled={!clean} />
      </form>
    </Sheet>
  );
}

/**
 * A project's own screen, shown above the message box until a chat starts: its instructions, its
 * files and its chats. Anything written in the box starts a new chat inside the project.
 */
export function ProjectPanel({
  userId,
  project,
  chats,
  onChange,
  onChatChange,
  onChatDeleted,
}: {
  userId: string;
  project: ProjectDetail;
  /** Your chats kept in this project. */
  chats: ChatRow[];
  onChange: (next: ProjectDetail | null) => void;
  onChatChange: (next: ChatRow) => void;
  onChatDeleted: (id: string) => void;
}) {
  const router = useRouter();
  const [sheet, setSheet] = useState<"instructions" | "rename" | "delete" | null>(null);
  const live = useRef(project);
  live.current = project;

  const card = "rounded-[22px] border border-line p-4";

  return (
    <div className="flex flex-col gap-5 pt-[6vh]" data-testid="project">
      <div className="flex flex-col gap-2">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold uppercase tracking-[0.1em] text-mute">
          <FolderIcon className="h-4 w-4" /> Project
        </span>
        <h2 className="break-words text-[34px] font-semibold leading-tight tracking-tight">{project.name}</h2>
        <div className="flex gap-2">
          <button type="button" className="press rounded-full border border-line px-3.5 py-1.5 text-[14px]" onClick={() => setSheet("rename")}>
            Rename
          </button>
          <button type="button" className="press rounded-full border border-line px-3.5 py-1.5 text-[14px]" onClick={() => setSheet("delete")}>
            Delete project
          </button>
        </div>
      </div>

      <section className={card} aria-label="Instructions">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-[17px] font-semibold">Instructions</h3>
          <button type="button" className="press rounded-full border border-line px-3.5 py-1.5 text-[14px]" onClick={() => setSheet("instructions")}>
            {project.instructions ? "Edit" : "Add"}
          </button>
        </div>
        <p className={`mt-2 line-clamp-4 whitespace-pre-wrap break-words text-[15px] ${project.instructions ? "" : "text-mute"}`} data-testid="project-instructions">
          {project.instructions || "Tell Depeche how to help in this project, for example: “I'm revising for A-level chemistry. Explain step by step and quiz me at the end.”"}
        </p>
      </section>

      <section className={card} aria-label="Files">
        <ContextFiles
          userId={userId}
          files={project.files}
          max={MAX_PROJECT_FILES}
          hint="Every chat in this project can read these. Photos, PDFs, Word, Excel, PowerPoint and text files."
          testId="project-file"
          onAdd={(ref) => addProjectFile(project.id, ref)}
          onRemove={(id) => removeProjectFile(id)}
          onChange={(files) => onChange({ ...live.current, files })}
        />
      </section>

      <section aria-label="Chats in this project">
        <h3 className="px-1 pb-1.5 text-[12px] font-semibold uppercase tracking-[0.1em] text-mute">Chats in this project</h3>
        {chats.length ? (
          <ul className="flex flex-col">
            {chats.map((c) => (
              <li key={c.id} className="chat-row relative border-b border-line last:border-b-0">
                <Link href={`/c/${c.id}`} prefetch={false} className="block truncate rounded-xl py-3.5 pl-1 pr-11 text-[16px] hover:bg-soft">
                  {c.title}
                </Link>
                <span className="absolute inset-y-0 right-0 flex items-center">
                  <ChatMenu
                    chat={c}
                    userId={userId}
                    label={`Options for ${c.title}`}
                    className="rounded-full p-2 text-mute hover:text-fg"
                    onChange={onChatChange}
                    onDeleted={() => onChatDeleted(c.id)}
                  />
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-1 text-[15px] text-mute">Start a chat below, or move one here from its three dots.</p>
        )}
      </section>

      {sheet === "instructions" ? (
        <InstructionsSheet
          value={project.instructions}
          onClose={() => setSheet(null)}
          onSave={async (instructions) => {
            const ok = await saveInstructions(project.id, instructions).catch(() => false);
            if (ok) onChange({ ...live.current, instructions: instructions.trim() });
            return ok;
          }}
        />
      ) : null}
      {sheet === "rename" ? (
        <RenameProjectSheet
          name={project.name}
          onClose={() => setSheet(null)}
          onSave={(name) => {
            setSheet(null);
            onChange({ ...live.current, name });
            renameProject(project.id, name).catch(() => {});
          }}
        />
      ) : null}
      {sheet === "delete" ? (
        <Sheet label="Delete project" onClose={() => setSheet(null)}>
          <p className="text-[16px] text-mute">
            &ldquo;<span className="text-fg">{project.name}</span>&rdquo; and its instructions and files will be deleted. Its chats are kept and move back to your
            chat list.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await deleteProject(project.id).catch(() => {});
              setSheet(null);
              onChange(null);
              router.push("/");
            }}
          >
            <SheetButtons onCancel={() => setSheet(null)} label="Delete" />
          </form>
        </Sheet>
      ) : null}
    </div>
  );
}

function InstructionsSheet({ value, onSave, onClose }: { value: string; onSave: (v: string) => Promise<boolean>; onClose: () => void }) {
  const [text, setText] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return (
    <Sheet label="Project instructions" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const ok = await onSave(text);
          setBusy(false);
          if (ok) onClose();
          else setError(true);
        }}
      >
        <p className="mb-3 text-[15px] text-mute">Every chat in this project follows these. Only you can see them.</p>
        <textarea
          autoFocus
          value={text}
          maxLength={MAX_PROJECT_INSTRUCTIONS}
          onChange={(e) => setText(e.target.value)}
          aria-label="Instructions"
          rows={7}
          className="max-h-[45vh] w-full resize-none rounded-2xl bg-soft px-4 py-3 text-[17px] leading-6 outline-none focus-visible:ring-1 focus-visible:ring-fg"
        />
        <p className="mt-1 text-right font-mono text-[12px] text-mute">
          {text.length} / {MAX_PROJECT_INSTRUCTIONS}
        </p>
        {error ? (
          <p role="alert" className="mt-2 text-[15px]">
            Couldn&apos;t save. Try again.
          </p>
        ) : null}
        <SheetButtons onCancel={onClose} label="Save" busy={busy} />
      </form>
    </Sheet>
  );
}

function RenameProjectSheet({ name, onSave, onClose }: { name: string; onSave: (name: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(name);
  const clean = cleanProjectName(value);
  return (
    <Sheet label="Rename project" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (clean) onSave(clean);
        }}
      >
        <input
          autoFocus
          value={value}
          maxLength={100}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Project name"
          enterKeyHint="done"
          className={input}
        />
        <SheetButtons onCancel={onClose} label="Save" disabled={!clean} />
      </form>
    </Sheet>
  );
}

/**
 * Files kept with a project or an assistant: added from the picker (uploaded to your own private
 * folder, then listed), and removed with their ×.
 */
export function ContextFiles({
  userId,
  files,
  max,
  hint,
  testId,
  onAdd,
  onRemove,
  onChange,
}: {
  userId: string;
  files: ProjectFile[];
  max: number;
  hint: string;
  testId: string;
  onAdd: (ref: FileRef) => Promise<ProjectFile | { error: string }>;
  onRemove: (id: string) => Promise<void>;
  onChange: (files: ProjectFile[]) => void;
}) {
  const [uploading, setUploading] = useState<{ id: string; name: string; error?: string }[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  const live = useRef(files);
  live.current = files;

  async function addFiles(picked: File[]) {
    const room = max - live.current.length - uploading.filter((u) => !u.error).length;
    const take = picked.slice(0, Math.max(0, room));
    const tooMany = picked.slice(take.length).map((f) => ({ id: crypto.randomUUID(), name: f.name, error: `Up to ${max} files` }));
    const jobs = take.map((file) => ({ file, id: crypto.randomUUID(), type: storedType(file) }));
    setUploading((u) => [
      ...u.filter((x) => !x.error),
      ...jobs.map((j) => ({ id: j.id, name: j.file.name, error: j.type ? undefined : refusal(j.file) })),
      ...tooMany,
    ]);
    await Promise.all(
      jobs.map(async ({ file, id, type }) => {
        if (!type) return;
        const up = await uploadFile(userId, file, type, id);
        const kept = "error" in up ? up : await onAdd(up).catch(() => ({ error: "Upload failed" }));
        if ("error" in kept) {
          setUploading((u) => u.map((x) => (x.id === id ? { ...x, error: kept.error } : x)));
          return;
        }
        setUploading((u) => u.filter((x) => x.id !== id));
        live.current = [...live.current, kept];
        onChange(live.current);
      }),
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[17px] font-semibold">Files</h3>
        <button
          type="button"
          className="press flex items-center gap-1 rounded-full border border-line px-3.5 py-1.5 text-[14px] disabled:opacity-40"
          onClick={() => picker.current?.click()}
          disabled={files.length >= max}
        >
          <PlusIcon className="h-4 w-4" /> Add files
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          data-testid={`${testId}-input`}
          onChange={(e) => {
            const picked = [...(e.target.files ?? [])];
            e.target.value = "";
            if (picked.length) addFiles(picked);
          }}
        />
      </div>
      {files.length || uploading.length ? (
        <ul className="mt-3 flex flex-col gap-2">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-3 rounded-2xl bg-soft px-3 py-2.5" data-testid={testId}>
              <FileIcon className="shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px]">{f.name}</span>
                <span className="block text-[12px] text-mute">{sizeLabel(f.size)}</span>
              </span>
              <button
                type="button"
                aria-label={`Remove ${f.name}`}
                className="press flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-mute hover:text-fg"
                onClick={() => {
                  live.current = live.current.filter((x) => x.id !== f.id);
                  onChange(live.current);
                  onRemove(f.id).catch(() => {});
                }}
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </li>
          ))}
          {uploading.map((u) => (
            <li key={u.id} className={`flex items-center gap-3 rounded-2xl px-3 py-2.5 ${u.error ? "border border-fg" : "bg-soft"}`}>
              <FileIcon className="shrink-0 text-mute" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px]">{u.name}</span>
                <span className="block text-[12px] text-mute">{u.error ?? "Uploading…"}</span>
              </span>
              {u.error ? (
                <button
                  type="button"
                  aria-label={`Dismiss ${u.name}`}
                  className="press flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-mute"
                  onClick={() => setUploading((list) => list.filter((x) => x.id !== u.id))}
                >
                  <CloseIcon className="h-4 w-4" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[15px] text-mute">{hint}</p>
      )}
    </>
  );
}
