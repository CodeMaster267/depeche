"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Markdown } from "@/components/markdown/Markdown";
import { canSearch, findModel } from "@/lib/ai/models";
import { latestLeaf, pathTo, titleFrom, versionsOf, type ChatRow, type MessageRow } from "@/lib/chat/thread";
import type { Shell } from "@/lib/chat/load";
import { deleteChat, pinChat, refreshChat, refreshShell, rememberModel, renameChat } from "@/app/c/actions";
import { DictateButton, ReadAloudButton, VoiceChatButton } from "@/components/voice/VoiceButtons";
import { VoiceMode } from "@/components/voice/VoiceMode";
import type { FileRef } from "@/lib/chat/files";
import { ACCEPT, AttachmentTray, useAttachments, type Pending } from "./Attachments";
import { AskAboutSelection, CostButton, FollowUps, QuoteChip } from "./Extras";
import { ModelPicker } from "./ModelPicker";
import { MemorySuggestion } from "./MemorySuggestion";
import { Sidebar } from "./Sidebar";
import { UserMessage, VersionSwitch } from "./Versions";
import { ArrowUpIcon, ChevronDownIcon, CodeIcon, CopyIcon, GlobeIcon, GlobeOffIcon, MenuIcon, MoreIcon, NewChatIcon, PaperclipIcon, RetryIcon, StopIcon } from "./icons";
import { SearchSuggestions } from "./Sources";
import { Activity, ViewSource, type LiveActivity } from "./Activity";
import { ResearchCard, ResearchIcon, runFor, useResearch } from "./Research";
import type { RunView } from "@/lib/research/types";
import type { Source } from "@/lib/chat/thread";

type Live = MessageRow & LiveActivity;

const SEARCH_PREF = "depeche:web-search";

const draftId = () => `local-${Math.random().toString(36).slice(2)}`;

/**
 * The chat screen: your chats on the left (a drawer on phones), the conversation, and the box to
 * write in. Replies stream in from /api/chat as they're written.
 */
export function ChatApp({
  shell: initialShell,
  chat: initialChat,
  messages: initial,
  all: initialAll,
}: {
  shell: Shell;
  chat: ChatRow | null;
  messages: MessageRow[];
  /** Every version of every message; the screen shows one path through them. */
  all?: MessageRow[];
}) {
  const router = useRouter();
  const [shell, setShell] = useState(initialShell);
  const [chat, setChat] = useState<ChatRow | null>(initialChat);
  // Edits and regenerations sit beside the originals, so a chat is a tree. `leaf` is where the
  // conversation on screen ends; flipping a version moves it.
  const [tree, setTree] = useState<Live[]>(initialAll ?? initial);
  const [leaf, setLeaf] = useState<string | null>(initial.at(-1)?.id ?? null);
  const messages = useMemo(() => pathTo(tree, leaf), [tree, leaf]);
  const [modelId, setModelId] = useState<string | null>(
    initialChat?.model && initialShell.modelIds.includes(initialChat.model) ? initialChat.model : initialShell.defaultModel,
  );
  const [picking, setPicking] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // The part of an answer the next message asks about, picked by selecting it.
  const [quote, setQuote] = useState<string | null>(null);
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
  // Deep research: on for the next message only.
  const [deep, setDeep] = useState(false);
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
        const all = found.all ?? found.messages;
        setTree(all);
        // Stay on the version being read, picking up anything added below it; else the newest.
        setLeaf((l) => (l && all.some((m) => m.id === l) ? latestLeaf(all, l) : (found.messages.at(-1)?.id ?? null)));
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

  const research = useResearch(chat?.id ?? null, () => sync());
  const toggleDeep = () => {
    setHint(deep ? "Deep research off" : "Deep research: several web searches and a long report with sources. Takes a few minutes.");
    clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), 3500);
    setDeep((on) => !on);
  };

  /** Starts deep research on the message; progress shows under it and the report arrives as a reply. */
  async function startResearch(text: string) {
    if (!model) return;
    setBanner(null);
    setBusy(true);
    pinnedToBottom.current = true;
    const before = messages.at(-1)?.id ?? null;
    const mine: Live = {
      id: draftId(),
      chat_id: chat?.id ?? "",
      parent_id: before,
      role: "user",
      content: { text },
      status: "completed",
      model: null,
      created_at: new Date().toISOString(),
    };
    setTree((m) => [...m, mine]);
    setLeaf(mine.id);
    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatId: chat?.id ?? null, parent: before, model: model.id, clientRequestId: crypto.randomUUID(), text }),
      });
      const out = (await res.json().catch(() => ({}))) as { error?: string; chatId?: string; userMessage?: MessageRow; run?: RunView };
      if (!res.ok || !out.chatId || !out.userMessage || !out.run) {
        setTree((list) => list.filter((m) => m.id !== mine.id));
        setLeaf(before);
        setDraft(text);
        setDeep(true);
        setBanner(out.error ?? "Couldn't start the research. Try again.");
        return;
      }
      if (!chat) {
        const created: ChatRow = { id: out.chatId, title: titleFrom(text), model: model.id, pinned: false, updated_at: new Date().toISOString() };
        setChat(created);
        setShell((s) => ({ ...s, chats: [created, ...s.chats] }));
        window.history.replaceState(null, "", `/c/${out.chatId}`);
      }
      const saved = out.userMessage;
      setTree((list) => list.map((m) => (m.id === mine.id ? saved : m)));
      setLeaf(saved.id);
      research.add(out.run);
    } catch {
      setTree((list) => list.filter((m) => m.id !== mine.id));
      setLeaf(before);
      setDraft(text);
      setBanner("Couldn't start the research. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const pickModel = (id: string) => {
    setModelId(id);
    setPicking(false);
    rememberModel(id).catch(() => {});
  };

  async function run(
    body: { text?: string; files?: FileRef[]; regenerate?: string; voice?: boolean; parent?: string | null; quote?: string },
    optimistic: Live[],
  ) {
    if (!model) return;
    const before = leaf;
    setBanner(null);
    setBusy(true);
    pinnedToBottom.current = true;
    const replyId = draftId();
    const placeholder: Live = {
      id: replyId,
      chat_id: chat?.id ?? "",
      parent_id: optimistic[0]?.id ?? body.regenerate ?? null,
      role: "assistant",
      content: { text: "" },
      status: "streaming",
      model: model.id,
      created_at: new Date().toISOString(),
      streaming: true,
    };
    setTree((m) => [...m, ...optimistic, placeholder]);
    setLeaf(replyId);
    const abort = new AbortController();
    abortRef.current = abort;
    const patchReply = (fn: (m: Live) => Live) => setTree((list) => list.map((m) => (m.id === replyId ? fn(m) : m)));

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
        setTree((list) => list.filter((m) => m.id !== replyId && !optimistic.some((o) => o.id === m.id)));
        setLeaf(before);
        if (body.text) setDraft(body.text);
        if (body.quote) setQuote(body.quote);
        setBanner(error ?? "Couldn't send that. Try again.");
        if (res.status === 409) sync();
        return;
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      let pending = "";
      let pendingThought = "";
      let frame = 0;
      const flush = () => {
        frame = 0;
        const add = pending;
        const thought = pendingThought;
        pending = "";
        pendingThought = "";
        if (thought) patchReply((m) => ({ ...m, content: { ...m.content, reasoning: (m.content.reasoning ?? "") + thought } }));
        if (add) patchReply((m) => ({ ...stopThinking(m), searchingNow: false, content: { ...m.content, text: (m.content.text ?? "") + add } }));
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
            | { type: "thinking"; text: string }
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
            if (local) {
              const real = ev.userMessage;
              setTree((list) =>
                list.map((m) => (m.id === local ? real : m.id === replyId ? { ...m, parent_id: real.id, chat_id: real.chat_id } : m)),
              );
            }
          } else if (ev.type === "text") {
            pending += ev.text;
            if (!frame) frame = requestAnimationFrame(flush);
          } else if (ev.type === "thinking") {
            pendingThought += ev.text;
            patchReply((m) => (m.thinkingNow ? m : { ...m, thinkingNow: true, searchingNow: false, thinkingSince: Date.now() }));
            if (!frame) frame = requestAnimationFrame(flush);
          } else if (ev.type === "searching") {
            if (frame) cancelAnimationFrame(frame);
            flush();
            const q = ev.query;
            const where = ev.where === "chat" ? "chat" : "web";
            patchReply((m) => ({
              ...stopThinking(m),
              searchingNow: true,
              searchingWhere: where,
              // Web searches and lookups in this chat are listed apart, so a line never names the wrong one.
              ...(where === "chat"
                ? { lookupQueries: q ? [...(m.lookupQueries ?? []), q] : (m.lookupQueries ?? []) }
                : { queries: q ? [...(m.queries ?? []), q] : (m.queries ?? []) }),
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
              setTree((list) => list.map((m) => (m.id === replyId ? saved : m)));
              setLeaf(saved.id);
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
    if ((!text && !attachments.ready) || attachments.uploading || busy || research.running || !model) return;
    if (deep && searchable) {
      if (attachments.items.length) return setBanner("Deep research works from your message only. Remove the attached files first.");
      if (!text) return;
      setDraft("");
      setDeep(false);
      startResearch(text);
      return;
    }
    setDraft("");
    setQuote(null);
    sendText(text, false, attachments.take(), quote ?? undefined);
  };

  // The message a new one follows: the end of the conversation on screen.
  const end = messages.at(-1);
  const after = chat && end && !end.id.startsWith("local-") ? { parent: end.id } : {};

  const sendText = (text: string, voice = false, files: FileRef[] = [], quote?: string) => {
    if ((!text && !files.length) || busy || !model) return;
    const mine: Live = {
      id: draftId(),
      chat_id: chat?.id ?? "",
      parent_id: after.parent ?? null,
      role: "user",
      content: { text, ...(files.length ? { files } : {}), ...(quote ? { quote } : {}) },
      status: "completed",
      model: null,
      created_at: new Date().toISOString(),
    };
    run({ text, ...(files.length ? { files } : {}), ...(voice ? { voice } : {}), ...(quote ? { quote } : {}), ...after }, [mine]);
  };

  /** Send a changed copy of one of your messages; the original and what followed it are kept. */
  const edit = (original: MessageRow, text: string) => {
    if (busy || !model || !chat) return;
    const files = original.content.files ?? [];
    const quote = original.content.quote;
    const mine: Live = {
      id: draftId(),
      chat_id: chat.id,
      parent_id: original.parent_id,
      role: "user",
      // An edited question still asks about the same part of an answer.
      content: { text, ...(files.length ? { files } : {}), ...(quote ? { quote } : {}) },
      status: "completed",
      model: null,
      created_at: new Date().toISOString(),
    };
    run({ text, ...(files.length ? { files } : {}), ...(quote ? { quote } : {}), parent: original.parent_id }, [mine]);
  };

  /** Show another version of a message, and the conversation that carried on from it. */
  const showVersion = (id: string) => {
    if (busy) return;
    pinnedToBottom.current = false;
    setLeaf(latestLeaf(tree, id));
  };

  const regenerate = (questionId: string) => {
    if (busy) return;
    // The old reply is kept as an earlier version; the new one is shown in its place.
    run({ regenerate: questionId }, []);
  };

  const shownIds = new Set(messages.map((m) => m.id));

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
          {chat ? <ChatMenu chat={chat} userId={shell.userId} onChange={(c) => { setChat(c); setShell((s) => ({ ...s, chats: s.chats.map((x) => (x.id === c.id ? c : x)) })); }} onDeleted={() => router.push("/")} /> : null}
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
                <div key={m.id} className="flex flex-col">
                  <UserMessage
                    message={m}
                    versions={versionsOf(tree, m)}
                    busy={busy || research.running}
                    onEdit={(text) => edit(m, text)}
                    onPickVersion={showVersion}
                  />
                  {(() => {
                    const run = runFor(research.runs, m.id, shownIds);
                    return run ? (
                      <div className="w-full pt-5">
                        <ResearchCard run={run} onStop={research.stop} />
                      </div>
                    ) : null;
                  })()}
                </div>
              ) : (
                <Reply
                  key={m.id}
                  message={m}
                  canRegenerate={!busy && !!m.parent_id && !m.parent_id.startsWith("local-")}
                  onRegenerate={() => m.parent_id && regenerate(m.parent_id)}
                  versions={<ReplyVersions message={m} tree={tree} busy={busy} onPick={showVersion} />}
                  // Suggested follow-ups only under the newest answer, once it's finished.
                  followUps={!busy && m.id === messages.at(-1)?.id ? m.content.followups : undefined}
                  onFollowUp={(q) => sendText(q)}
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
            quote={quote}
            onClearQuote={() => setQuote(null)}
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
            onStop={() => (research.running ? research.stop() : abortRef.current?.abort())}
            busy={busy || research.running}
            disabled={!model}
            search={search && searchable}
            searchable={searchable}
            onToggleSearch={toggleSearch}
            deep={deep && searchable}
            onToggleDeep={toggleDeep}
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

      <AskAboutSelection
        scroller={scroller}
        onAsk={(text) => {
          setQuote(text);
          document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Depeche"]')?.focus();
        }}
      />
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

function ReplyVersions({ message, tree, busy, onPick }: { message: Live; tree: Live[]; busy: boolean; onPick: (id: string) => void }) {
  const versions = versionsOf(tree, message);
  return (
    <VersionSwitch
      what="reply"
      index={Math.max(0, versions.findIndex((v) => v.id === message.id))}
      total={versions.length}
      disabled={busy}
      onPick={(i) => onPick(versions[i].id)}
    />
  );
}

/** The reply stopped thinking (it started writing or searching): bank the time it spent. */
function stopThinking(m: Live): Live {
  if (!m.thinkingNow) return m;
  return { ...m, thinkingNow: false, thinkingSince: undefined, thoughtSoFar: (m.thoughtSoFar ?? 0) + (m.thinkingSince ? Date.now() - m.thinkingSince : 0) };
}

function Reply({
  message: m,
  canRegenerate,
  onRegenerate,
  followUps,
  onFollowUp,
  versions,
}: {
  message: Live;
  canRegenerate: boolean;
  onRegenerate: () => void;
  followUps?: string[];
  onFollowUp: (q: string) => void;
  /** "‹ 1/2 ›" when this reply has other versions. */
  versions?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [source, setSource] = useState(false);
  const info = findModel(m.model);
  const text = m.content.text ?? "";
  return (
    <article data-testid="reply" aria-busy={m.streaming || undefined} className="flex flex-col gap-3">
      <Activity message={m} />
      {text ? (
        // Text selected in here can be asked about (see AskAboutSelection).
        <div data-reply-text className="contents">
          <Markdown text={text} streaming={m.streaming} />
        </div>
      ) : null}
      {m.streaming && !m.searchingNow && !m.thinkingNow ? (
        <span aria-label="Writing" className="block h-6">
          <span className="stream-cursor" />
        </span>
      ) : null}
      {!m.streaming && m.content.suggestions ? <SearchSuggestions html={m.content.suggestions} /> : null}
      {m.content.notice ? <p className="text-[14px] text-mute">{m.content.notice}</p> : null}
      {!m.streaming && m.memory ? <MemorySuggestion key={m.memory.id} memory={m.memory} /> : null}
      {!m.streaming && followUps?.length ? <FollowUps questions={followUps} onAsk={onFollowUp} /> : null}
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
            {text ? (
              <button
                type="button"
                className="rounded-lg p-2 hover:text-fg"
                aria-label={source ? "Hide Markdown source" : "View Markdown source"}
                title="View source"
                aria-pressed={source}
                onClick={() => setSource(!source)}
              >
                <CodeIcon />
              </button>
            ) : null}
            {versions}
            {copied ? <span className="text-[13px]">Copied</span> : null}
          </span>
          <span className="flex items-center gap-1 font-mono text-[12px]">
            {info?.short ?? m.model}
            {typeof m.content.cost === "number" && (m.content.cost > 0 || m.content.usage) ? (
              <>
                <span aria-hidden>{" · "}</span>
                <CostButton content={m.content} />
              </>
            ) : null}
          </span>
        </div>
      ) : null}
      {source && !m.streaming && text ? <ViewSource text={text} /> : null}
    </article>
  );
}

function Composer({
  quote,
  onClearQuote,
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
  deep,
  onToggleDeep,
  voice,
  onVoice,
  onDictated,
  onVoiceError,
}: {
  quote: string | null;
  onClearQuote: () => void;
  search: boolean;
  searchable: boolean;
  onToggleSearch: () => void;
  deep: boolean;
  onToggleDeep: () => void;
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
      {quote ? <QuoteChip quote={quote} onClear={onClearQuote} /> : null}
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
        <button
          type="button"
          onClick={onToggleDeep}
          disabled={!searchable || disabled}
          aria-pressed={deep}
          aria-label="Deep research"
          title={!searchable ? "This model can't search the web" : deep ? "Deep research on for this message" : "Deep research: a long report with sources"}
          className={`press flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${deep ? "bg-inv text-on-inv" : "text-faint hover:text-fg"}`}
        >
          <ResearchIcon />
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
          placeholder={deep ? "What to research?" : "Message Depeche"}
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

function ChatMenu({ chat, userId, onChange, onDeleted }: { chat: ChatRow; userId: string; onChange: (c: ChatRow) => void; onDeleted: () => void }) {
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
                try {
                  const [{ supabaseBrowser }, { downloadChat }] = await Promise.all([import("@/lib/supabase/browser"), import("@/lib/export/collect")]);
                  await downloadChat(supabaseBrowser(), userId, chat.id);
                } catch {
                  window.alert("Couldn't download this chat. Try again.");
                }
              }}
            >
              Download
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
