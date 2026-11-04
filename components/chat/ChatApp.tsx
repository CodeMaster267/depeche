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
import { createProject } from "@/app/p/actions";
import type { ProjectDetail } from "@/lib/chat/projects";
import type { AssistantRow } from "@/lib/chat/assistants";
import { ProjectsContext, type ProjectsValue } from "./projects-context";
import { ProjectPanel } from "./Projects";
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
import { CanvasIcon, CanvasMessage, CanvasOpener, CanvasPane, useCanvas } from "./Canvas";
import { ChatMenu } from "./ChatMenu";
import { DeletionNotice } from "./DeletionNotice";
import { UserMessage, VersionSwitch } from "./Versions";
import { ArrowUpIcon, ChevronDownIcon, CodeIcon, CopyIcon, FolderIcon, GlobeIcon, GlobeOffIcon, MenuIcon, NewChatIcon, PaperclipIcon, RetryIcon, SparkIcon, StopIcon } from "./icons";
import { SearchSuggestions } from "./Sources";
import { Activity, ViewSource, type LiveActivity } from "./Activity";
import { ResearchCard, ResearchIcon, runFor, useResearch } from "./Research";
import type { RunView } from "@/lib/research/types";
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
  project: initialProject = null,
  assistant = null,
  all: initialAll,
}: {
  shell: Shell;
  chat: ChatRow | null;
  messages: MessageRow[];
  /** On a project's own screen: new chats start inside it. */
  project?: ProjectDetail | null;
  /** Starting a chat with a saved assistant. */
  assistant?: AssistantRow | null;
  /** Every version of every message; the screen shows one path through them. */
  all?: MessageRow[];
}) {
  const router = useRouter();
  const [shell, setShell] = useState(initialShell);
  const [chat, setChat] = useState<ChatRow | null>(initialChat);
  const [project, setProject] = useState<ProjectDetail | null>(initialProject);
  const projectsValue: ProjectsValue = {
    projects: shell.projects,
    create: async (name) => {
      const made = await createProject(name);
      if (made) setShell((s) => ({ ...s, projects: [made, ...s.projects.filter((p) => p.id !== made.id)] }));
      return made;
    },
  };
  // The project this screen is in: the one open, or the open chat's.
  const projectId = chat ? (chat.project_id ?? null) : (project?.id ?? null);
  const projectName = shell.projects.find((p) => p.id === projectId)?.name ?? project?.name ?? null;
  // The saved assistant this chat is with, when it's still one you can see.
  const assistantId = chat ? (chat.assistant_id ?? null) : (assistant?.id ?? null);
  const withAssistant = shell.assistants.find((a) => a.id === assistantId) ?? assistant;
  // Edits and regenerations sit beside the originals, so a chat is a tree. `leaf` is where the
  // conversation on screen ends; flipping a version moves it.
  const [tree, setTree] = useState<Live[]>(initialAll ?? initial);
  const [leaf, setLeaf] = useState<string | null>(initial.at(-1)?.id ?? null);
  const messages = useMemo(() => pathTo(tree, leaf), [tree, leaf]);
  const [modelId, setModelId] = useState<string | null>(
    initialChat?.model && initialShell.modelIds.includes(initialChat.model)
      ? initialChat.model
      : assistant?.model && initialShell.modelIds.includes(assistant.model)
        ? assistant.model
        : initialShell.defaultModel,
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
  // Deep research: on for the next message only.
  const [deep, setDeep] = useState(false);
  const attachments = useAttachments(initialShell.userId);
  // Replies being written right now: one, or two or three when comparing models.
  const aborts = useRef(new Set<AbortController>());
  const stopAll = () => aborts.current.forEach((a) => a.abort());
  // Models chosen to answer the next message side by side (none: just the model in the header).
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const streamingReply = messages.find((m) => m.streaming);
  const lastReply = messages.at(-1)?.role === "assistant" ? messages.at(-1) : undefined;
  const hasCanvas = messages.some((m) => m.role === "assistant" && (m.content.text ?? "").includes("canvas:"));
  const canvas = useCanvas(chat?.id ?? null, streamingReply ? (streamingReply.content.text ?? "") : null, lastReply?.content.text ?? null, hasCanvas);

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
    canvas.refresh();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      // The person's canvas edits are saved first, so the AI works on what they see.
      const open = await canvas.beforeSend();
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chatId,
          model: model.id,
          clientRequestId,
          search: search && canSearch(model),
          ...(!chatId && project ? { projectId: project.id } : {}),
          ...(!chatId && assistant ? { assistantId: assistant.id } : {}),
          ...open,
          ...body,
        }),
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
                project_id: project?.id ?? null,
                assistant_id: assistant?.id ?? null,
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
    if ((!text && !attachments.ready) || attachments.uploading || busy || research.running || !model) return;
    if (deep && searchable && !imaging) {
      if (attachments.items.length) return setBanner("Deep research works from your message only. Remove the attached files first.");
      if (!text) return;
      setDraft("");
      setDeep(false);
      startResearch(text);
      return;
    }
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

  const shownIds = new Set(messages.map((m) => m.id));

  // A fresh chat. The home screen that a chat was started on is the same page as the new one, so
  // it gets a fresh key (?new=…) to start over; a reply still being written finishes on the server.
  const startNew = () => {
    setDrawer(false);
    router.push(initialChat || initialProject ? "/" : `/?new=${Date.now().toString(36)}`);
  };
  // The header's new chat button stays in the project the screen is in.
  const startNewHere = () => {
    if (!projectId) return startNew();
    setDrawer(false);
    router.push(initialChat || initialProject?.id !== projectId ? `/p/${projectId}` : `/p/${projectId}?new=${Date.now().toString(36)}`);
  };
  useEffect(() => {
    if (!initialChat && window.location.search.includes("new=")) window.history.replaceState(null, "", window.location.pathname);
  }, [initialChat]);
  // Opening a project. A chat begun on that project's screen is still that page as far as the
  // router knows, so it gets a fresh key (?new=…) to show the project again.
  const openProject = (id: string) => {
    setDrawer(false);
    router.push(initialProject?.id === id && !initialChat ? `/p/${id}?new=${Date.now().toString(36)}` : `/p/${id}`);
  };
  // A project's screen can come from the browser's page cache, so check its chats are current.
  useEffect(() => {
    if (initialProject) refreshShell().then(setShell, () => {});
  }, [initialProject]);
  // A project renamed or deleted on its screen.
  const changeProject = (next: ProjectDetail | null) => {
    const id = project?.id;
    setProject(next);
    setShell((s) => ({
      ...s,
      projects: next ? s.projects.map((p) => (p.id === next.id ? { ...p, name: next.name } : p)) : s.projects.filter((p) => p.id !== id),
      chats: next ? s.chats : s.chats.map((c) => (c.project_id === id ? { ...c, project_id: null } : c)),
    }));
  };

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
    <ProjectsContext.Provider value={projectsValue}>
    <div data-part="app" className="flex h-dvh overflow-hidden">
      {/* Chats: always visible on wide screens, a drawer on phones. */}
      <aside data-part="sidebar-desktop" className={`hidden w-[300px] shrink-0 border-r border-line ${canvas.isOpen ? "2xl:block" : "md:block"}`}>
        <Sidebar
          {...shell}
          chats={shell.chats}
          activeId={chat?.id ?? null}
              activeProjectId={projectId}
              onOpenProject={openProject}
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
              activeProjectId={projectId}
              onOpenProject={openProject}
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
            {chat && projectId && projectName ? (
              <Link
                href={`/p/${projectId}`}
                prefetch={false}
                onClick={(e) => {
                  e.preventDefault();
                  openProject(projectId);
                }}
                className="flex max-w-full items-center gap-1 text-[13px] text-mute hover:text-fg md:-mr-2 md:max-w-[30%] md:text-[15px]"
                aria-label={`Project: ${projectName}`}
              >
                <FolderIcon className="h-4 w-4 shrink-0" />
                <span className="truncate">{projectName}</span>
                <span aria-hidden className="hidden md:inline">/</span>
              </Link>
            ) : null}
            {chat && withAssistant ? (
              <Link
                href={`/assistants/${withAssistant.id}`}
                prefetch={false}
                className="flex max-w-full items-center gap-1 text-[13px] text-mute hover:text-fg md:-mr-2 md:max-w-[30%] md:text-[15px]"
                aria-label={`Assistant: ${withAssistant.name}`}
              >
                <SparkIcon className="h-4 w-4 shrink-0" />
                <span className="truncate">{withAssistant.name}</span>
                <span aria-hidden className="hidden md:inline">/</span>
              </Link>
            ) : null}
            <h1 className="max-w-full truncate text-[17px] font-semibold md:text-[18px]">
              {chat?.title ?? (project ? project.name : assistant ? assistant.name : "New chat")}
            </h1>
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
          {canvas.canvases.length && !canvas.isOpen ? (
            <button type="button" className="p-2 text-mute hover:text-fg" aria-label="Open canvas" onClick={() => canvas.open(canvas.canvases[0].title)}>
              <CanvasIcon />
            </button>
          ) : null}
          {chat ? <ChatMenu chat={chat} userId={shell.userId} onChange={changeChat} onDeleted={() => chatDeleted(chat.id)} /> : null}
          {chat || messages.length ? (
            <Link
              href={projectId ? `/p/${projectId}` : "/"}
              onClick={(e) => {
                e.preventDefault();
                startNewHere();
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
          <CanvasOpener.Provider value={canvas.open}>
          <div data-part="thread" className="mx-auto flex w-full max-w-[760px] flex-col gap-7 px-5 py-6 md:px-8">
            {messages.length === 0 && project && !chat ? (
              <ProjectPanel
                userId={shell.userId}
                project={project}
                chats={shell.chats.filter((c) => c.project_id === project.id)}
                onChange={changeProject}
                onChatChange={changeChat}
                onChatDeleted={chatDeleted}
              />
            ) : messages.length === 0 && assistant && !chat ? (
              <div className="flex flex-col gap-2 pt-[12vh]" data-testid="assistant-start">
                <span className="flex items-center gap-1.5 text-[13px] font-semibold uppercase tracking-[0.1em] text-mute">
                  <SparkIcon className="h-4 w-4" /> Assistant{assistant.mine ? "" : " shared by your family"}
                </span>
                <h2 className="break-words text-[34px] font-semibold leading-tight tracking-tight">{assistant.name}</h2>
                {assistant.description ? <p className="text-[17px] text-mute">{assistant.description}</p> : null}
                <Link href={`/assistants/${assistant.id}`} className="self-start text-[15px] text-mute underline underline-offset-4">
                  {assistant.mine ? "Edit" : "What it's been told"}
                </Link>
              </div>
            ) : messages.length === 0 ? (
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
                {!noModels && shell.assistants.length ? (
                  <ul className="mt-5 flex flex-wrap gap-2" aria-label="Start with an assistant">
                    {shell.assistants.slice(0, 6).map((a) => (
                      <li key={a.id}>
                        <Link
                          href={`/?assistant=${a.id}`}
                          prefetch={false}
                          className="press flex items-center gap-1.5 rounded-full border border-line px-3.5 py-2 text-[15px]"
                        >
                          <SparkIcon className="h-4 w-4 text-mute" />
                          {a.name}
                        </Link>
                      </li>
                    ))}
                    <li>
                      <Link href="/assistants" className="press flex items-center rounded-full px-3.5 py-2 text-[15px] text-mute">
                        All assistants
                      </Link>
                    </li>
                  </ul>
                ) : null}
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
                <CanvasMessage.Provider key={m.id} value={m.id.startsWith("local-") ? null : m.id}>
                <Reply
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
                </CanvasMessage.Provider>
              ),
            )}
          </div>
          </CanvasOpener.Provider>
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
            placeholder={imaging ? (editing || attachments.items.some((x) => x.mime.startsWith("image/")) ? "Describe what to change" : "Describe a picture to make") : deep && searchable ? "What to research?" : project && !chat ? `New chat in ${project.name}` : assistant && !chat ? `Message ${assistant.name}` : "Message Depeche"}
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
            onStop={() => (research.running ? research.stop() : stopAll())}
            busy={busy || research.running}
            disabled={!model}
            search={search && searchable}
            searchable={searchable}
            onToggleSearch={toggleSearch}
            deep={deep && searchable && !imaging}
            onToggleDeep={toggleDeep}
            deepable={searchable && !imaging}
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

      <CanvasPane state={canvas} />

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
    </ProjectsContext.Provider>
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
  deep,
  onToggleDeep,
  deepable,
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
  deep: boolean;
  onToggleDeep: () => void;
  /** Whether this model can do deep research (it must search the web, and not be a picture model). */
  deepable: boolean;
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
  const look = useLookTexts();
  // A look can reword the usual prompt; picture prompts stay as they are.
  const hint = placeholder === "Message Depeche" && look.placeholder ? look.placeholder : placeholder;
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
        <button
          type="button"
          onClick={onToggleDeep}
          disabled={!deepable || disabled}
          aria-pressed={deep}
          aria-label="Deep research"
          title={!deepable ? "This model can't do deep research" : deep ? "Deep research on for this message" : "Deep research: a long report with sources"}
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
          placeholder={hint}
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
