"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Markdown } from "@/components/markdown/Markdown";
import type { RunContext } from "@/components/markdown/RunCode";
import { MODELS, canSearch, findModel, type Model } from "@/lib/ai/models";
import { latestLeaf, pathTo, titleFrom, versionsOf, type ChatRow, type MessageRow } from "@/lib/chat/thread";
import type { Shell } from "@/lib/chat/load";
import { archiveChat, refreshChat, refreshShell, rememberModel } from "@/app/c/actions";
import { DictateButton, ReadAloudButton, VoiceChatButton } from "@/components/voice/VoiceButtons";
import { VoiceMode } from "@/components/voice/VoiceMode";
import type { FileRef } from "@/lib/chat/files";
import { markAway } from "@/lib/push/client";
import { ACCEPT, AttachmentTray, useAttachments, type Pending } from "./Attachments";
import { AskAboutSelection, CostButton, FollowUps, QuoteChip } from "./Extras";
import { ModelPicker } from "./ModelPicker";
import { Compare } from "./Compare";
import { comparedWith } from "@/lib/chat/compare";
import { MemorySuggestion } from "./MemorySuggestion";
import { Sidebar } from "./Sidebar";
import { ChatMenu } from "./ChatMenu";
import { DeletionNotice } from "./DeletionNotice";
import { UserMessage, VersionSwitch } from "./Versions";
import { ArrowUpIcon, ChevronDownIcon, CodeIcon, CopyIcon, GlobeIcon, GlobeOffIcon, MenuIcon, NewChatIcon, PaperclipIcon, RetryIcon, StopIcon } from "./icons";
import { SearchSuggestions } from "./Sources";
import { Activity, ViewSource, type LiveActivity } from "./Activity";
import { EditingChip, MakingPicture, ReplyPictures, isPicture } from "./Pictures";
import type { Source } from "@/lib/chat/thread";
import { SOURCE_NAMES } from "@/lib/import/types";
import { LOOK_ACTION, Shortcuts, useLookTexts, type LookAction } from "@/components/design/Look";

type Live = MessageRow &
  LiveActivity & {
    /** A picture model is drawing (editing one, if `editing`). */
    making?: boolean;
    editing?: boolean;
  };

const SEARCH_PREF = "depeche:web-search";

type CompareTag = { id: string; slot: number };
type RunOptions = {
  /** Answer with this model instead of the one in the header (comparing). */
  model?: Model;
  /** The chat, when it was created by another reply a moment ago. */
  chatId?: string;
  /** Show this reply once it's written (false for the other models in a comparison). */
  follow?: boolean;
  /** Called once the server has saved the question. */
  onStart?: (chatId: string, questionId: string) => void;
};

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
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
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
  const attachments = useAttachments(initialShell.userId);
  // Replies being written right now: one, or two or three when comparing models.
  const aborts = useRef(new Set<AbortController>());
  const stopAll = () => aborts.current.forEach((a) => a.abort());
  // Models chosen to answer the next message side by side (none: just the model in the header).
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  const model = findModel(modelId);
  const selected = model;
  // DeepSeek and some Groq models can't search the web, so the globe is shown off and greyed out while one is picked.
  const searchable = canSearch(model);
  // Picture models make or edit a picture from each message.
  const imaging = !!model?.image;
  const pictureModels = MODELS.filter((m) => m.image && shell.modelIds.includes(m.id));
  // The newest picture in the chat is edited by the next message to a picture model, unless the
  // person taps × to make a new one.
  const newest = messages.at(-1);
  const lastPicture =
    newest?.role === "assistant" && !newest.streaming ? newest.content.files?.find(isPicture) : undefined;
  const [editLast, setEditLast] = useState(true);
  useEffect(() => setEditLast(true), [lastPicture?.path]);
  const editing = imaging && editLast && lastPicture && !attachments.items.some((x) => x.ref?.path === lastPicture.path) ? lastPicture : undefined;
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
    if (aborts.current.size) return;
    const next = await refreshShell().catch(() => null);
    if (next) setShell(next);
    if (chat) {
      const found = await refreshChat(chat.id).catch(() => null);
      if (found && !aborts.current.size) {
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

  // Leaving the app while an answer is being written asks for a notification when it's ready
  // (only on devices where notifications are on, from Account). Coming back cancels it.
  // Each answer being written (several at once when comparing models): whether the app has
  // marked it "away", and whether its stream is still open.
  const writing = useRef(new Map<string, { away: boolean; live: boolean }>());
  useEffect(() => {
    const onChange = () => {
      const hidden = document.visibilityState === "hidden";
      for (const [id, w] of writing.current) {
        if (!hidden && !w.live) {
          // Back after the connection dropped: the answer is still being written on the server,
          // so keep the mark and let the notification say when it's saved.
          writing.current.delete(id);
        } else if (w.live && w.away !== hidden) {
          w.away = hidden;
          markAway(id, hidden);
        }
      }
    };
    document.addEventListener("visibilitychange", onChange);
    window.addEventListener("pagehide", onChange);
    return () => {
      document.removeEventListener("visibilitychange", onChange);
      window.removeEventListener("pagehide", onChange);
    };
  }, []);

  const pickModel = (id: string) => {
    setModelId(id);
    setCompareIds([]);
    setPicking(false);
    // New chats start with the last chat model, never a picture model.
    if (!findModel(id)?.image) rememberModel(id).catch(() => {});
  };

  /** Edit a picture: switch to a picture model if needed (the one that made it, if it can). */
  const editPicture = (f: FileRef, madeBy: string | null) => {
    if (!imaging) {
      const next = pictureModels.find((m) => m.id === madeBy) ?? pictureModels[0];
      if (!next) return;
      setModelId(next.id);
    }
    if (f.path === lastPicture?.path) setEditLast(true);
    else attachments.attach(f);
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Depeche"]')?.focus();
  };

  async function run(
    body: { text?: string; files?: FileRef[]; regenerate?: string; voice?: boolean; parent?: string | null; quote?: string; compare?: CompareTag },
    optimistic: Live[],
    opts: RunOptions = {},
  ) {
    const model = opts.model ?? selected;
    if (!model) return;
    const follow = opts.follow ?? true;
    const before = leaf;
    if (follow) setBanner(null);
    setBusy(true);
    pinnedToBottom.current = true;
    const replyId = draftId();
    const placeholder: Live = {
      id: replyId,
      chat_id: chat?.id ?? "",
      parent_id: optimistic[0]?.id ?? body.regenerate ?? null,
      role: "assistant",
      content: body.compare ? { text: "", compare: body.compare } : { text: "" },
      status: "streaming",
      model: model.id,
      created_at: new Date().toISOString(),
      streaming: true,
    };
    setTree((m) => [...m, ...optimistic, placeholder]);
    if (follow) setLeaf(replyId);
    const abort = new AbortController();
    aborts.current.add(abort);
    const patchReply = (fn: (m: Live) => Live) => setTree((list) => list.map((m) => (m.id === replyId ? fn(m) : m)));

    let chatId = opts.chatId ?? chat?.id ?? null;
    const clientRequestId = crypto.randomUUID();
    writing.current.set(clientRequestId, { away: false, live: true });
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatId, model: model.id, clientRequestId, search: search && canSearch(model), ...body }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        const { error } = (await res.json().catch(() => ({}))) as { error?: string };
        if (!follow) {
          // Another model in a comparison: its pane says why (often the monthly limit).
          patchReply((m) => ({ ...m, streaming: false, status: "failed", content: { ...m.content, error: error ?? "Couldn't answer. Try again." } }));
          return;
        }
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
            | { type: "making"; editing?: boolean }
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
            opts.onStart?.(ev.chatId, ev.userMessage.id);
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
          } else if (ev.type === "making") {
            const editing = !!ev.editing;
            patchReply((m) => (m.making ? m : { ...m, making: true, editing }));
          } else if (ev.type === "notice") {
            patchReply((m) => ({ ...m, content: { ...m.content, notice: ev.text } }));
          } else {
            if (frame) cancelAnimationFrame(frame);
            flush();
            const saved = ev.message;
            if (saved) {
              setTree((list) => list.map((m) => (m.id === replyId ? saved : m)));
              if (follow) setLeaf(saved.id);
              else setLeaf((l) => (l === replyId ? saved.id : l));
              // Code in a reply that just arrived may run by itself.
              setFresh((f) => new Set(f).add(saved.id));
              setShell((s) => ({ ...s, spent: s.spent + Number(saved.content.cost ?? 0) }));
            } else patchReply((m) => ({ ...m, streaming: false, status: "failed", content: { ...m.content, error: ev.error } }));
          }
        }
      }
      if (frame) flush();
    } catch {
      if (abort.signal.aborted && model.image) {
        // A picture is still made and saved after Stop (it's billed either way): fetch it later.
        patchReply((m) => ({ ...m, streaming: false, making: false, content: { ...m.content, notice: "Still making the picture. It will appear here when it's ready." } }));
        for (const wait of [15_000, 45_000, 100_000]) setTimeout(() => sync(), wait);
      } else if (abort.signal.aborted) {
        patchReply((m) => ({ ...m, streaming: false, status: "stopped" }));
        // The server saves what was written; pick up its copy once it has.
        setTimeout(() => sync(), 1500);
      } else {
        patchReply((m) => ({ ...m, streaming: false, status: "failed", content: { ...m.content, error: "The connection dropped." } }));
        setTimeout(() => sync(), 2500);
      }
    } finally {
      // Read here and now, so no notification is needed (one already asked for still arrives).
      const w = writing.current.get(clientRequestId);
      if (w) w.live = false;
      if (document.visibilityState === "visible") writing.current.delete(clientRequestId);
      aborts.current.delete(abort);
      if (!aborts.current.size) setBusy(false);
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
    // A picture model needs to be told what to make or change.
    if (imaging && !text) return;
    setDraft("");
    setQuote(null);
    const files = attachments.take();
    sendText(text, false, editing ? [editing, ...files].slice(0, 5) : files, quote ?? undefined);
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
    const others = compareIds.map((id) => findModel(id)).filter((m): m is Model => !!m && !m.image && shell.modelIds.includes(m.id));
    if (!voice && others.length >= 2) {
      // Comparing: the first model answers the message as usual; once it's saved, the others answer
      // the same message. Each is its own request with its own spending hold.
      const group = crypto.randomUUID();
      const [first, ...rest] = others;
      setCompareIds([]);
      // The first model's answer is the one carried on from unless another is picked.
      setModelId(first.id);
      run({ text, ...(files.length ? { files } : {}), ...(quote ? { quote } : {}), ...after, compare: { id: group, slot: 0 } }, [mine], {
        model: first,
        onStart: (chatId, questionId) =>
          rest.forEach((m, i) =>
            run({ regenerate: questionId, compare: { id: group, slot: i + 1 } }, [], { model: m, chatId, follow: false }),
          ),
      });
      return;
    }
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

  // Code in replies can open this chat's files and send its results back as a message.
  const sendRef = useRef(sendText);
  sendRef.current = sendText;
  const fileKey = messages.flatMap((m) => (m.role === "user" ? (m.content.files ?? []).map((f) => f.path) : [])).join("|");
  const runContexts = useMemo(() => {
    const files = messages.flatMap((m) => (m.role === "user" ? (m.content.files ?? []) : []));
    const onSend = (t: string) => sendRef.current(t);
    return { fresh: { files, autoRun: true, onSend } as RunContext, old: { files, autoRun: false, onSend } as RunContext };
    // The files only change when fileKey does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey]);

  /** Continue the conversation from one model's answer, and keep using that model. */
  const choose = (reply: MessageRow) => {
    showVersion(reply.id);
    if (reply.model && shell.modelIds.includes(reply.model)) {
      setModelId(reply.model);
      rememberModel(reply.model).catch(() => {});
    }
  };

  /** Ask one model in a comparison again (after a failure, say), keeping its place. */
  const retryCompared = (reply: MessageRow) => {
    if (busy || !reply.parent_id || !reply.content.compare) return;
    run({ regenerate: reply.parent_id, compare: reply.content.compare }, [], {
      model: findModel(reply.model) ?? undefined,
      follow: reply.id === leaf || messages.some((m) => m.id === reply.id),
    });
  };

  const regenerate = (questionId: string) => {
    if (busy) return;
    // The old reply is kept as an earlier version; the new one is shown in its place.
    run({ regenerate: questionId }, []);
  };

  // A fresh chat. The home screen that a chat was started on is the same page as the new one, so
  // it gets a fresh key (?new=…) to start over; a reply still being written finishes on the server.
  const startNew = () => {
    setDrawer(false);
    router.push(initialChat ? "/" : `/?new=${Date.now().toString(36)}`);
  };
  useEffect(() => {
    if (!initialChat && window.location.search.includes("new=")) window.history.replaceState(null, "", "/");
  }, [initialChat]);
  const look = useLookTexts();

  // Buttons a person's design adds (components/design/Look.tsx) ask for these.
  const lookAction = useRef<(a: LookAction) => void>(() => {});
  lookAction.current = (a) => {
    if (a === "new-chat") startNew();
    else if (a === "chats") setDrawer(true);
    else if (a === "choose-model") setPicking(true);
    else if (a === "voice-chat" && canListen && model) setVoiceOpen(true);
    else if (a === "web-search" && searchable) toggleSearch();
    else if (a === "attach") document.querySelector<HTMLInputElement>('[data-testid="file-input"]')?.click();
  };
  useEffect(() => {
    const on = (e: Event) => lookAction.current((e as CustomEvent<LookAction>).detail);
    window.addEventListener(LOOK_ACTION, on);
    return () => window.removeEventListener(LOOK_ACTION, on);
  }, []);

  // A chat renamed, pinned, archived or restored from a menu. Archived chats leave the list.
  const changeChat = (next: ChatRow) => {
    if (chat?.id === next.id) setChat(next);
    setShell((s) => {
      const rest = s.chats.filter((x) => x.id !== next.id);
      if (next.archived_at) return { ...s, chats: rest };
      const was = s.chats.find((x) => x.id === next.id);
      const chats = was ? s.chats.map((x) => (x.id === next.id ? next : x)) : [next, ...rest].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      return { ...s, chats };
    });
  };
  const chatDeleted = (id: string) => {
    setShell((s) => ({ ...s, chats: s.chats.filter((x) => x.id !== id) }));
    if (chat?.id === id) startNew();
  };

  return (
    <div data-part="app" className="flex h-dvh overflow-hidden">
      {/* Chats: always visible on wide screens, a drawer on phones. */}
      <aside data-part="sidebar-desktop" className="hidden w-[300px] shrink-0 border-r border-line md:block">
        <Sidebar
          {...shell}
          chats={shell.chats}
          activeId={chat?.id ?? null}
          onNavigate={() => {}}
          onNewChat={startNew}
          onChatChange={changeChat}
          onChatDeleted={chatDeleted}
        />
      </aside>
      {drawer ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} />
          <aside data-part="drawer" className="enter-glitch absolute inset-y-0 left-0 w-[86%] max-w-[340px] bg-bg">
            <Sidebar
              {...shell}
              activeId={chat?.id ?? null}
              onNavigate={() => setDrawer(false)}
              onNewChat={startNew}
              onClose={() => setDrawer(false)}
              onChatChange={changeChat}
              onChatDeleted={chatDeleted}
            />
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          data-part="chat-header"
          className="flex items-center gap-2 border-b border-line px-3 pb-2 md:px-6"
          style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
        >
          <button type="button" data-part="menu-button" className="p-2 md:hidden" aria-label="Open menu" onClick={() => setDrawer(true)}>
            <MenuIcon />
          </button>
          <div className="flex min-w-0 flex-1 flex-col items-center md:flex-row md:items-center md:gap-4">
            <h1 className="max-w-full truncate text-[17px] font-semibold md:text-[18px]">{chat?.title ?? "New chat"}</h1>
            {model ? (
              <button
                type="button"
                onClick={() => setPicking(true)}
                className="press flex items-center gap-1 text-[14px] text-mute md:rounded-full md:border md:border-line md:px-3.5 md:py-1.5 md:text-fg"
                aria-label={compareIds.length ? `Comparing ${compareIds.length} models. Change models` : `Model: ${model.name}. Change model`}
              >
                {compareIds.length ? `Compare ${compareIds.length} models` : model.name} <ChevronDownIcon />
              </button>
            ) : null}
          </div>
          <Shortcuts place="header" onChat isAdmin={shell.isAdmin} className="max-md:hidden" />
          {chat ? <ChatMenu chat={chat} userId={shell.userId} onChange={changeChat} onDeleted={() => chatDeleted(chat.id)} /> : null}
          {chat || messages.length ? (
            <Link
              href="/"
              onClick={(e) => {
                e.preventDefault();
                startNew();
              }}
              className="press glass flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
              aria-label="New chat"
              title="New chat"
            >
              <NewChatIcon className="h-[19px] w-[19px]" />
            </Link>
          ) : (
            <span className="h-10 w-10 shrink-0 md:hidden" aria-hidden />
          )}
        </header>
        <DeletionNotice
          expiring={shell.expiring}
          onKept={(ids) => setShell((s) => ({ ...s, expiring: s.expiring.filter((c) => !ids.includes(c.id)) }))}
        />
        {chat?.archived_at ? (
          <div className="flex items-center justify-center gap-3 border-b border-line px-4 py-2 text-[14px] text-mute" role="status">
            <span>This chat is archived. Writing in it brings it back.</span>
            <button
              type="button"
              className="press rounded-full border border-line px-3 py-1 text-fg"
              onClick={() => {
                changeChat({ ...chat, archived_at: null });
                archiveChat(chat.id, false).catch(() => {});
              }}
            >
              Restore
            </button>
          </div>
        ) : null}

        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          onScroll={(e) => {
            const el = e.currentTarget;
            pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div data-part="thread" className="mx-auto flex w-full max-w-[760px] flex-col gap-7 px-5 py-6 md:px-8">
            {messages.length === 0 ? (
              <div className="flex flex-col gap-2 pt-[12vh]">
                <h2 data-part="greeting" className="text-[34px] font-semibold tracking-tight">{look.greeting(shell.name)}</h2>
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
                  <p data-part="greeting-line" className="text-[17px] text-mute">{look.subtitle ?? "What's on your mind?"}</p>
                )}
              </div>
            ) : null}
            {chat?.imported_from ? (
              <p data-testid="imported-from" className="text-center text-[13px] text-mute">
                Imported from {SOURCE_NAMES[chat.imported_from]}
                {chat.created_at ? ` · started ${new Date(chat.created_at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}` : ""}
              </p>
            ) : null}
            {messages.map((m) =>
              m.role === "user" ? (
                <UserMessage
                  key={m.id}
                  message={m}
                  versions={versionsOf(tree, m)}
                  busy={busy}
                  onEdit={(text) => edit(m, text)}
                  onPickVersion={showVersion}
                />
              ) : comparedWith(tree, m).length > 1 ? (
                <Compare
                  key={m.content.compare!.id}
                  replies={comparedWith(tree, m)}
                  chosenId={m.id}
                  canChoose={!busy && m.id === messages.at(-1)?.id}
                  onChoose={(id) => {
                    const r = tree.find((x) => x.id === id);
                    if (r) choose(r);
                  }}
                  renderReply={(r) => (
                    <Reply
                      message={r}
                      canRegenerate={!busy && !!r.parent_id && !r.parent_id.startsWith("local-")}
                      onRegenerate={() => retryCompared(r)}
                      // Side-by-side answers don't start code by themselves; each has a Run button.
                      run={runContexts.old}
                      // Follow-ups carry on from the picked answer, so only it offers them.
                      followUps={!busy && r.id === m.id && m.id === messages.at(-1)?.id ? r.content.followups : undefined}
                      onFollowUp={(q) => sendText(q)}
                    />
                  )}
                />
              ) : (
                <Reply
                  key={m.id}
                  message={m}
                  onEdit={pictureModels.length ? (f) => editPicture(f, m.model) : undefined}
                  run={fresh.has(m.id) ? runContexts.fresh : runContexts.old}
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

        <div data-part="composer-wrap" className="mx-auto w-full max-w-[760px] px-3 md:px-8" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
          {/* On phones the header has no room, so header buttons join the composer's row. */}
          <Shortcuts place="composer" onChat isAdmin={shell.isAdmin} className="mb-2 overflow-x-auto" />
          <Shortcuts place="header" onChat isAdmin={shell.isAdmin} className="mb-2 overflow-x-auto md:hidden" />
          {compareIds.length ? (
            <div data-testid="compare-chip" className="mb-2 flex items-center justify-between gap-3 rounded-2xl border border-line px-4 py-2 text-[14px]">
              <span className="min-w-0 truncate">
                Next message goes to {compareIds.map((id) => findModel(id)?.short ?? id).join(", ")}
              </span>
              <button type="button" className="shrink-0 text-mute underline underline-offset-4" onClick={() => setCompareIds([])}>
                Cancel
              </button>
            </div>
          ) : null}
          {banner ? (
            <p role="alert" className="mb-2 rounded-2xl border border-fg px-4 py-3 text-[15px]">
              {banner}
            </p>
          ) : null}
          <Composer
            editing={editing}
            onClearEditing={() => setEditLast(false)}
            placeholder={imaging ? (editing || attachments.items.some((x) => x.mime.startsWith("image/")) ? "Describe what to change" : "Describe a picture to make") : "Message Depeche"}
            quote={quote}
            onClearQuote={() => setQuote(null)}
            attachments={attachments.items}
            onAttach={async (files) => {
              const skipped = await attachments.add(files);
              if (skipped) setBanner("You can attach up to 5 files to one message.");
            }}
            onRemoveAttachment={attachments.remove}
            canSend={!attachments.uploading && (!!draft.trim() || (attachments.ready && !imaging))}
            value={draft}
            onChange={setDraft}
            onSend={send}
            onStop={stopAll}
            busy={busy}
            disabled={!model}
            search={search && searchable}
            searchable={searchable}
            onToggleSearch={toggleSearch}
            voice={canListen && !!model && !imaging}
            onVoice={() => setVoiceOpen(true)}
            onDictated={(t) => setDraft((d) => (d.trim() ? `${d.trimEnd()} ${t}` : t))}
            onVoiceError={setBanner}
          />
          {hint ? (
            <p role="status" className="mt-2 text-center text-[12px] text-mute">
              {hint}
            </p>
          ) : (
            <p data-part="keyboard-hint" className="mt-2 hidden text-center text-[12px] text-mute md:block">Enter to send · Shift + Enter for a new line</p>
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
          onStop={stopAll}
          onClose={() => setVoiceOpen(false)}
        />
      ) : null}
      {picking ? (
        <ModelPicker
          available={shell.modelIds}
          current={modelId}
          onPick={pickModel}
          onClose={() => setPicking(false)}
          comparing={compareIds}
          onCompare={(ids) => {
            setCompareIds(ids);
            setPicking(false);
          }}
        />
      ) : null}
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
  onEdit,
  followUps,
  onFollowUp,
  versions,
  run,
}: {
  message: Live;
  canRegenerate: boolean;
  onRegenerate: () => void;
  onEdit?: (f: FileRef) => void;
  followUps?: string[];
  onFollowUp: (q: string) => void;
  /** "‹ 1/2 ›" when this reply has other versions. */
  versions?: ReactNode;
  /** Lets Python in the reply open this chat's files and send its results. */
  run: RunContext;
}) {
  const [copied, setCopied] = useState(false);
  const [source, setSource] = useState(false);
  const info = findModel(m.model);
  const text = m.content.text ?? "";
  return (
    <article data-testid="reply" aria-busy={m.streaming || undefined} className="flex flex-col gap-3">
      <Activity message={m} />
      {m.content.files?.length ? <ReplyPictures files={m.content.files} onEdit={onEdit} /> : null}
      {text ? (
        // Text selected in here can be asked about (see AskAboutSelection).
        <div data-reply-text className="contents">
          <Markdown text={text} streaming={m.streaming} run={run} />
        </div>
      ) : null}
      {m.streaming && m.making ? <MakingPicture editing={m.editing} /> : null}
      {m.streaming && !m.searchingNow && !m.thinkingNow && !m.making ? (
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
          <span data-part="reply-model" className="flex items-center gap-1 font-mono text-[12px]">
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
  editing,
  onClearEditing,
  placeholder,
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
  voice,
  onVoice,
  onDictated,
  onVoiceError,
}: {
  editing?: FileRef;
  onClearEditing: () => void;
  placeholder: string;
  quote: string | null;
  onClearQuote: () => void;
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
  const { placeholder } = useLookTexts();
  const [dragging, setDragging] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  return (
    <form
      data-part="composer"
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
      {editing ? <EditingChip file={editing} onClear={onClearEditing} /> : null}
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
          placeholder={placeholder}
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
