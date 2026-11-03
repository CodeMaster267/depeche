"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Markdown } from "@/components/markdown/Markdown";
import { canSearch, findModel } from "@/lib/ai/models";
import { titleFrom, type ChatRow, type MessageRow } from "@/lib/chat/thread";
import type { Shell } from "@/lib/chat/load";
import { deleteChat, pinChat, refreshChat, refreshShell, rememberModel, renameChat } from "@/app/c/actions";
import { DictateButton, ReadAloudButton, VoiceChatButton } from "@/components/voice/VoiceButtons";
import { VoiceMode } from "@/components/voice/VoiceMode";
import type { FileRef } from "@/lib/chat/files";
import { ACCEPT, AttachmentTray, MessageFiles, useAttachments, type Pending } from "./Attachments";
import { ModelPicker } from "./ModelPicker";
import { MemorySuggestion } from "./MemorySuggestion";
import { Sidebar } from "./Sidebar";
import { ArrowUpIcon, ChevronDownIcon, CopyIcon, GlobeIcon, GlobeOffIcon, MenuIcon, MoreIcon, NewChatIcon, PaperclipIcon, RetryIcon, StopIcon } from "./icons";
import { SearchSuggestions, Searching, Sources } from "./Sources";
import type { Source } from "@/lib/chat/thread";

type Live = MessageRow & { streaming?: boolean; queries?: string[]; searchingNow?: boolean; searchingWhere?: "web" | "chat" };

const SEARCH_PREF = "depeche:web-search";

const draftId = () => `local-${Math.random().toString(36).slice(2)}`;

/**
 * The chat screen: your chats on the left (a drawer on phones), the conversation, and the box to
 * write in. Replies stream in from /api/chat as they're written.
 */
export function ChatApp({ shell: initialShell, chat: initialChat, messages: initial }: { shell: Shell; chat: ChatRow | null; messages: MessageRow[] }) {
  const router = useRouter();
  const [shell, setShell] = useState(initialShell);
  const [chat, setChat] = useState<ChatRow | null>(initialChat);
  const [messages, setMessages] = useState<Live[]>(initial);
  const [modelId, setModelId] = useState<string | null>(
    initialChat?.model && initialShell.modelIds.includes(initialChat.model) ? initialChat.model : initialShell.defaultModel,
  );
  const [picking, setPicking] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Web search is on unless this person turned it off on this device.
  const [search, setSearch] = useState(true);
  useEffect(() => {
    try {
      if (localStorage.getItem(SEARCH_PREF) === "off") setSearch(false);
    } catch {
      // Private browsing can block storage; search simply stays on.
    }
  }, []);
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const toggleSearch = () => {
    setHint(search ? "Web search off" : "Web search on: the model searches when it needs to");
    clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), 2500);
    setSearch((on) => {
      try {
        localStorage.setItem(SEARCH_PREF, on ? "off" : "on");
      } catch {
        // Not remembered, but still switched for now.
      }
      return !on;
    });
  };
  const [voiceOpen, setVoiceOpen] = useState(false);
  const attachments = useAttachments(initialShell.userId);
  const abortRef = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  const model = findModel(modelId);
  // DeepSeek and some Groq models can't search the web, so the globe is shown off and greyed out while one is picked.
  const searchable = canSearch(model);
  const noModels = shell.modelIds.length === 0;
  // Listening needs a provider that understands audio (Groq, OpenAI or Google); Claude has none.
  const canListen = shell.modelIds.some((id) => ["groq", "openai", "google"].includes(findModel(id)?.provider ?? ""));

  // Keep the newest text in view while a reply streams, unless the person scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Another device may have added chats or replies: catch up whenever the app comes back.
  const sync = useCallback(async () => {
    if (abortRef.current) return;
    const next = await refreshShell().catch(() => null);
    if (next) setShell(next);
    if (chat) {
      const found = await refreshChat(chat.id).catch(() => null);
      if (found && !abortRef.current) {
        setChat(found.chat);
        setMessages(found.messages);
      }
    }
  }, [chat]);
  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && sync();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [sync]);

  const pickModel = (id: string) => {
    setModelId(id);
    setPicking(false);
    rememberModel(id).catch(() => {});
  };

  async function run(body: { text?: string; files?: FileRef[]; regenerate?: string; voice?: boolean }, optimistic: Live[]) {
    if (!model) return;
    setBanner(null);
    setBusy(true);
    pinnedToBottom.current = true;
    const replyId = draftId();
    const placeholder: Live = {
      id: replyId,
      chat_id: chat?.id ?? "",
      parent_id: null,
      role: "assistant",
      content: { text: "" },
      status: "streaming",
      model: model.id,
      created_at: new Date().toISOString(),
      streaming: true,
    };
    setMessages((m) => [...m, ...optimistic, placeholder]);
    const abort = new AbortController();
    abortRef.current = abort;
    const patchReply = (fn: (m: Live) => Live) => setMessages((list) => list.map((m) => (m.id === replyId ? fn(m) : m)));

    let chatId = chat?.id ?? null;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatId, model: model.id, clientRequestId: crypto.randomUUID(), search: search && canSearch(model), ...body }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        const { error } = (await res.json().catch(() => ({}))) as { error?: string };
        // Nothing was sent: take the message back off the screen and return it to the box.
        setMessages((list) => list.filter((m) => m.id !== replyId && !optimistic.some((o) => o.id === m.id)));
        if (body.text) setDraft(body.text);
        setBanner(error ?? "Couldn't send that. Try again.");
        if (res.status === 409) sync();
        return;
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      let pending = "";
      let frame = 0;
      const flush = () => {
        frame = 0;
        const add = pending;
        pending = "";
        if (add) patchReply((m) => ({ ...m, searchingNow: false, content: { ...m.content, text: (m.content.text ?? "") + add } }));
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          const ev = JSON.parse(line) as
            | { type: "start"; chatId: string; userMessage: MessageRow }
            | { type: "text"; text: string }
            | { type: "notice"; text: string }
            | { type: "searching"; query?: string; where?: "chat" }
            | { type: "sources"; sources: Source[] }
            | { type: "done" | "error"; message: MessageRow | null; error?: string };
          if (ev.type === "start") {
            if (!chatId) {
              chatId = ev.chatId;
              const created: ChatRow = {
                id: ev.chatId,
                title: titleFrom(ev.userMessage.content.text || ev.userMessage.content.files?.[0]?.name || ""),
                model: model.id,
                pinned: false,
                updated_at: new Date().toISOString(),
              };
              setChat(created);
              setShell((s) => ({ ...s, chats: [created, ...s.chats] }));
              window.history.replaceState(null, "", `/c/${ev.chatId}`);
            }
            const local = optimistic[0]?.id;
            if (local) setMessages((list) => list.map((m) => (m.id === local ? ev.userMessage : m)));
          } else if (ev.type === "text") {
            pending += ev.text;
            if (!frame) frame = requestAnimationFrame(flush);
          } else if (ev.type === "searching") {
            if (frame) cancelAnimationFrame(frame);
            flush();
            const q = ev.query;
            const where = ev.where === "chat" ? "chat" : "web";
            patchReply((m) => ({
              ...m,
              searchingNow: true,
              searchingWhere: where,
              // A new kind of search starts its own list, so the line never names the wrong one.
              queries: [...(m.searchingWhere === where ? (m.queries ?? []) : []), ...(q ? [q] : [])],
            }));
          } else if (ev.type === "sources") {
            const sources = ev.sources;
            patchReply((m) => ({ ...m, content: { ...m.content, sources } }));
          } else if (ev.type === "notice") {
            patchReply((m) => ({ ...m, content: { ...m.content, notice: ev.text } }));
          } else {
            if (frame) cancelAnimationFrame(frame);
            flush();
            const saved = ev.message;
            if (saved) {
              setMessages((list) => list.map((m) => (m.id === replyId ? saved : m)));
              setShell((s) => ({ ...s, spent: s.spent + Number(saved.content.cost ?? 0) }));
            } else patchReply((m) => ({ ...m, streaming: false, status: "failed", content: { ...m.content, error: ev.error } }));
          }
        }
      }
      if (frame) flush();
    } catch {
      if (abort.signal.aborted) {
        patchReply((m) => ({ ...m, streaming: false, status: "stopped" }));
        // The server saves what was written; pick up its copy once it has.
        setTimeout(() => sync(), 1500);
      } else {
        patchReply((m) => ({ ...m, streaming: false, status: "failed", content: { ...m.content, error: "The connection dropped." } }));
        setTimeout(() => sync(), 2500);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      setShell((s) => ({
        ...s,
        chats: s.chats
          .map((c) => (c.id === chatId ? { ...c, updated_at: new Date().toISOString(), model: model.id } : c))
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
      }));
    }
  }

  const send = () => {
    const text = draft.trim();
    if ((!text && !attachments.ready) || attachments.uploading || busy || !model) return;
    setDraft("");
    sendText(text, false, attachments.take());
  };

  const sendText = (text: string, voice = false, files: FileRef[] = []) => {
    if ((!text && !files.length) || busy || !model) return;
    const mine: Live = {
      id: draftId(),
      chat_id: chat?.id ?? "",
      parent_id: null,
      role: "user",
      content: files.length ? { text, files } : { text },
      status: "completed",
      model: null,
      created_at: new Date().toISOString(),
    };
    run({ text, ...(files.length ? { files } : {}), ...(voice ? { voice } : {}) }, [mine]);
  };

  const regenerate = (questionId: string) => {
    if (busy) return;
    // The old reply is kept in the database; the new one replaces it on screen.
    setMessages((list) => list.slice(0, list.findIndex((m) => m.id === questionId) + 1));
    run({ regenerate: questionId }, []);
  };

  const lastUser = [...messages].reverse().find((m) => m.role === "user" && !m.id.startsWith("local-"));

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Chats: always visible on wide screens, a drawer on phones. */}
      <aside className="hidden w-[300px] shrink-0 border-r border-line md:block">
        <Sidebar {...shell} chats={shell.chats} activeId={chat?.id ?? null} onNavigate={() => {}} />
      </aside>
      {drawer ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} />
          <aside className="enter-glitch absolute inset-y-0 left-0 w-[86%] max-w-[340px] bg-bg">
            <Sidebar
              {...shell}
              activeId={chat?.id ?? null}
              onNavigate={() => setDrawer(false)}
              onClose={() => setDrawer(false)}
            />
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex items-center gap-2 border-b border-line px-3 pb-2 md:px-6"
          style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
        >
          <button type="button" className="p-2 md:hidden" aria-label="Open menu" onClick={() => setDrawer(true)}>
            <MenuIcon />
          </button>
          <div className="flex min-w-0 flex-1 flex-col items-center md:flex-row md:items-center md:gap-4">
            <h1 className="max-w-full truncate text-[17px] font-semibold md:text-[18px]">{chat?.title ?? "New chat"}</h1>
            {model ? (
              <button
                type="button"
                onClick={() => setPicking(true)}
                className="press flex items-center gap-1 text-[14px] text-mute md:rounded-full md:border md:border-line md:px-3.5 md:py-1.5 md:text-fg"
                aria-label={`Model: ${model.name}. Change model`}
              >
                {model.name} <ChevronDownIcon />
              </button>
            ) : null}
          </div>
          {chat ? <ChatMenu chat={chat} onChange={(c) => { setChat(c); setShell((s) => ({ ...s, chats: s.chats.map((x) => (x.id === c.id ? c : x)) })); }} onDeleted={() => router.push("/")} /> : null}
          <Link href="/" className="p-2 md:hidden" aria-label="New chat">
            <NewChatIcon />
          </Link>
        </header>

        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          onScroll={(e) => {
            const el = e.currentTarget;
            pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div className="mx-auto flex w-full max-w-[760px] flex-col gap-7 px-5 py-6 md:px-8">
            {messages.length === 0 ? (
              <div className="flex flex-col gap-2 pt-[12vh]">
                <h2 className="text-[34px] font-semibold tracking-tight">Hi, {shell.name}.</h2>
                {noModels ? (
                  <p className="text-[17px] text-mute">
                    {shell.isAdmin ? (
                      <>
                        Add an AI key in{" "}
                        <Link href="/family" className="text-fg underline underline-offset-4">
                          Family settings
                        </Link>{" "}
                        to start chatting.
                      </>
                    ) : (
                      "Your family admin hasn't added any AI keys yet. Once they do, you can start chatting."
                    )}
                  </p>
                ) : (
                  <p className="text-[17px] text-mute">What&apos;s on your mind?</p>
                )}
              </div>
            ) : null}
            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="flex flex-col items-end gap-2">
                  {m.content.files?.length ? <MessageFiles files={m.content.files} /> : null}
                  {m.content.text ? (
                    <div
                      data-testid="user-message"
                      className="max-w-[85%] whitespace-pre-wrap break-words rounded-[22px] bg-inv px-5 py-3 text-[17px] leading-relaxed text-on-inv"
                    >
                      {m.content.text}
                    </div>
                  ) : null}
                </div>
              ) : (
                <Reply
                  key={m.id}
                  message={m}
                  canRegenerate={!busy && !!lastUser && m.parent_id === lastUser.id}
                  onRegenerate={() => m.parent_id && regenerate(m.parent_id)}
                />
              ),
            )}
          </div>
        </div>

        <div className="mx-auto w-full max-w-[760px] px-3 md:px-8" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
          {banner ? (
            <p role="alert" className="mb-2 rounded-2xl border border-fg px-4 py-3 text-[15px]">
              {banner}
            </p>
          ) : null}
          <Composer
            attachments={attachments.items}
            onAttach={async (files) => {
              const skipped = await attachments.add(files);
              if (skipped) setBanner("You can attach up to 5 files to one message.");
            }}
            onRemoveAttachment={attachments.remove}
            canSend={!attachments.uploading && (!!draft.trim() || attachments.ready)}
            value={draft}
            onChange={setDraft}
            onSend={send}
            onStop={() => abortRef.current?.abort()}
            busy={busy}
            disabled={!model}
            search={search && searchable}
            searchable={searchable}
            onToggleSearch={toggleSearch}
            voice={canListen && !!model}
            onVoice={() => setVoiceOpen(true)}
            onDictated={(t) => setDraft((d) => (d.trim() ? `${d.trimEnd()} ${t}` : t))}
            onVoiceError={setBanner}
          />
          {hint ? (
            <p role="status" className="mt-2 text-center text-[12px] text-mute">
              {hint}
            </p>
          ) : (
            <p className="mt-2 hidden text-center text-[12px] text-mute md:block">Enter to send · Shift + Enter for a new line</p>
          )}
        </div>
      </div>

      {voiceOpen ? (
        <VoiceMode
          messages={messages}
          busy={busy}
          banner={banner}
          onSend={(t) => sendText(t, true)}
          onStop={() => abortRef.current?.abort()}
          onClose={() => setVoiceOpen(false)}
        />
      ) : null}
      {picking ? <ModelPicker available={shell.modelIds} current={modelId} onPick={pickModel} onClose={() => setPicking(false)} /> : null}
    </div>
  );
}

function Reply({ message: m, canRegenerate, onRegenerate }: { message: Live; canRegenerate: boolean; onRegenerate: () => void }) {
  const [copied, setCopied] = useState(false);
  const info = findModel(m.model);
  const text = m.content.text ?? "";
  const cost = m.content.cost;
  return (
    <article data-testid="reply" aria-busy={m.streaming || undefined} className="flex flex-col gap-3">
      {text ? <Markdown text={text} streaming={m.streaming} /> : null}
      {m.streaming && m.searchingNow ? <Searching queries={m.queries ?? []} where={m.searchingWhere} /> : null}
      {m.streaming && !m.searchingNow ? (
        <span aria-label="Writing" className="block h-6">
          <span className="stream-cursor" />
        </span>
      ) : null}
      {!m.streaming && m.content.sources?.length ? <Sources sources={m.content.sources} searches={m.content.searches} /> : null}
      {!m.streaming && m.content.suggestions ? <SearchSuggestions html={m.content.suggestions} /> : null}
      {m.content.notice ? <p className="text-[14px] text-mute">{m.content.notice}</p> : null}
      {!m.streaming && m.memory ? <MemorySuggestion key={m.memory.id} memory={m.memory} /> : null}
      {m.status === "stopped" ? <p className="text-[14px] text-mute">Stopped.</p> : null}
      {m.status === "failed" ? (
        <p role="alert" className="rounded-2xl border border-fg px-4 py-3 text-[15px]">
          {m.content.error ?? "Something went wrong."}
        </p>
      ) : null}
      {!m.streaming ? (
        <div className="flex items-center justify-between gap-3 text-mute">
          <span className="flex items-center gap-1">
            {text ? (
              <button
                type="button"
                className="-ml-2 rounded-lg p-2 hover:text-fg"
                aria-label={copied ? "Copied" : "Copy reply"}
                onClick={async () => {
                  await navigator.clipboard.writeText(text);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                <CopyIcon />
              </button>
            ) : null}
            {canRegenerate ? (
              <button type="button" className="rounded-lg p-2 hover:text-fg" aria-label="Try again" onClick={onRegenerate}>
                <RetryIcon />
              </button>
            ) : null}
            {text ? <ReadAloudButton text={text} /> : null}
            {copied ? <span className="text-[13px]">Copied</span> : null}
          </span>
          <span className="font-mono text-[12px]">
            {info?.short ?? m.model}
            {typeof cost === "number" && cost > 0 ? ` · $${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}` : ""}
          </span>
        </div>
      ) : null}
    </article>
  );
}

function Composer({
  attachments,
  onAttach,
  onRemoveAttachment,
  canSend,
  value,
  onChange,
  onSend,
  onStop,
  busy,
  disabled,
  search,
  searchable,
  onToggleSearch,
  voice,
  onVoice,
  onDictated,
  onVoiceError,
}: {
  search: boolean;
  searchable: boolean;
  onToggleSearch: () => void;
  attachments: Pending[];
  onAttach: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  canSend: boolean;
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  disabled: boolean;
  voice: boolean;
  onVoice: () => void;
  onDictated: (text: string) => void;
  onVoiceError: (msg: string) => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  return (
    <form
      className={`rounded-[26px] border bg-bg p-2 focus-within:border-fg ${dragging ? "border-fg" : "border-line"}`}
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
      onDragOver={(e) => {
        if (disabled || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        setDragging(false);
        if (disabled || !e.dataTransfer.files.length) return;
        e.preventDefault();
        onAttach([...e.dataTransfer.files]);
      }}
    >
      <AttachmentTray items={attachments} onRemove={onRemoveAttachment} />
      <div className="flex items-end gap-1">
        <input
          ref={picker}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          data-testid="file-input"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length) onAttach(files);
          }}
        />
        <button
          type="button"
          onClick={() => picker.current?.click()}
          disabled={disabled}
          aria-label="Attach photos or files"
          className="press flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-mute hover:text-fg disabled:opacity-30"
        >
          <PaperclipIcon />
        </button>
        <button
          type="button"
          onClick={onToggleSearch}
          disabled={!searchable}
          aria-pressed={search}
          aria-label="Search the web"
          title={!searchable ? "This model can't search the web" : search ? "Web search on: the model searches when it needs to" : "Web search off"}
          className={`press flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${search ? "text-fg" : "text-faint"}`}
        >
          {search ? <GlobeIcon /> : <GlobeOffIcon />}
        </button>
        <textarea
          ref={box}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (!files.length) return;
            e.preventDefault();
            onAttach(files);
          }}
          onKeyDown={(e) => {
            // On a keyboard, Enter sends. On phones, Enter is a new line and the button sends.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
              e.preventDefault();
              onSend();
            }
          }}
          rows={1}
          placeholder="Message Depeche"
          aria-label="Message Depeche"
          disabled={disabled}
          className="max-h-[220px] min-h-[44px] flex-1 resize-none bg-transparent py-2.5 text-[17px] leading-6 outline-none placeholder:text-faint disabled:opacity-50"
        />
        {voice ? <DictateButton onText={onDictated} onError={onVoiceError} disabled={disabled} /> : null}
        {busy ? (
          <button type="button" onClick={onStop} aria-label="Stop" className="press glass flex h-11 w-11 shrink-0 items-center justify-center rounded-full">
            <StopIcon />
          </button>
        ) : voice && !value.trim() && !attachments.length ? (
          <VoiceChatButton onOpen={onVoice} disabled={disabled} />
        ) : (
          <button
            type="submit"
            aria-label="Send"
            disabled={disabled || !canSend}
            className="press glass flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-opacity disabled:opacity-30"
          >
            <ArrowUpIcon />
          </button>
        )}
      </div>
    </form>
  );
}

function ChatMenu({ chat, onChange, onDeleted }: { chat: ChatRow; onChange: (c: ChatRow) => void; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" className="p-2 text-mute" aria-label="Chat options" aria-expanded={open} onClick={() => setOpen(!open)}>
        <MoreIcon />
      </button>
      {open ? (
        <>
          <button type="button" aria-label="Close" className="fixed inset-0 z-20 cursor-default" onClick={() => setOpen(false)} />
          <div role="menu" className="absolute right-0 top-11 z-30 w-48 overflow-hidden rounded-2xl border border-line bg-bg py-1 text-[16px] shadow-lg">
            <button
              type="button"
              role="menuitem"
              className="block w-full px-4 py-2.5 text-left hover:bg-soft"
              onClick={async () => {
                setOpen(false);
                const title = window.prompt("Rename chat", chat.title)?.trim();
                if (title) {
                  onChange({ ...chat, title });
                  await renameChat(chat.id, title);
                }
              }}
            >
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              className="block w-full px-4 py-2.5 text-left hover:bg-soft"
              onClick={async () => {
                setOpen(false);
                onChange({ ...chat, pinned: !chat.pinned });
                await pinChat(chat.id, !chat.pinned);
              }}
            >
              {chat.pinned ? "Unpin" : "Pin"}
            </button>
            <button
              type="button"
              role="menuitem"
              className="block w-full px-4 py-2.5 text-left hover:bg-soft"
              onClick={async () => {
                setOpen(false);
                if (!window.confirm("Delete this chat? This can't be undone.")) return;
                await deleteChat(chat.id);
                onDeleted();
              }}
            >
              Delete
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
