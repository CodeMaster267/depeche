"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Wordmark } from "@/components/Wordmark";
import { GlassCode } from "@/components/Glass";
import { listArchived } from "@/app/c/actions";
import type { ChatRow } from "@/lib/chat/thread";
import { searchChats } from "@/app/c/actions";
import { marked, type ChatHit } from "@/lib/chat/find";
import { ChatMenu } from "./ChatMenu";
import { AccountMenu } from "./AccountMenu";
import { ArchiveIcon, BackIcon, CloseIcon, PlusIcon, SearchIcon } from "./icons";
import { Shortcuts } from "@/components/design/Look";

function group(chats: ChatRow[]) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  const buckets: [string, ChatRow[]][] = [
    ["Pinned", []],
    ["Today", []],
    ["Yesterday", []],
    ["Previous 7 days", []],
    ["Earlier", []],
  ];
  for (const c of chats) {
    const t = new Date(c.updated_at).getTime();
    const i = c.pinned ? 0 : t >= startOfToday.getTime() ? 1 : t >= startOfToday.getTime() - day ? 2 : t >= startOfToday.getTime() - 7 * day ? 3 : 4;
    buckets[i][1].push(c);
  }
  return buckets.filter(([, list]) => list.length);
}

/** Your chats, newest first, plus the way to your account and (for admins) family settings. */
export function Sidebar({
  userId,
  chats,
  activeId,
  name,
  isAdmin,
  spent,
  cap,
  noLimit = false,
  onNavigate,
  onNewChat,
  onClose,
  onChatChange,
  onChatDeleted,
}: {
  userId: string;
  chats: ChatRow[];
  activeId: string | null;
  name: string;
  isAdmin: boolean;
  spent: number;
  cap: number;
  /** Their family admin took the monthly limit away. */
  noLimit?: boolean;
  onNavigate: () => void;
  /** Start a new chat (the link alone can't restart the home screen a chat began on). */
  onNewChat: () => void;
  onClose?: () => void;
  /** A chat was renamed, pinned, archived or restored from its menu. */
  onChatChange: (next: ChatRow) => void;
  onChatDeleted: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  // The archived chats, once the person opens them (fetched then, not with every page).
  const [archived, setArchived] = useState<ChatRow[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  useEffect(() => {
    if (showArchived) listArchived().then(setArchived, () => setArchived([]));
  }, [showArchived]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = showArchived ? (archived ?? []) : chats;
    const found = needle ? list.filter((c) => c.title.toLowerCase().includes(needle)) : list;
    return showArchived ? (found.length ? ([["Archived", found]] as [string, ChatRow[]][]) : []) : group(found);
  }, [chats, archived, showArchived, q]);
  // Words inside messages (your own chats only, never archived ones). Chats whose title matched are
  // already listed above; the rest show the message that matched.
  const needle = showArchived ? "" : q.trim().toLowerCase();
  const inMessages = useMessageSearch(needle ? q : "");
  const byId = useMemo(() => new Map(chats.map((c) => [c.id, c])), [chats]);
  const titled = needle ? shown.reduce((n, [, l]) => n + l.length, 0) : 0;
  const hits = needle
    ? (inMessages.hits ?? []).filter((h) => byId.has(h.chatId) && !byId.get(h.chatId)!.title.toLowerCase().includes(needle))
    : [];
  const change = (next: ChatRow) => {
    onChatChange(next);
    if (showArchived) setArchived((list) => (list ?? []).flatMap((c) => (c.id !== next.id ? [c] : next.archived_at ? [next] : [])));
  };

  return (
    <nav aria-label="Chats" data-part="sidebar" className="flex h-full flex-col gap-4 px-4" style={{ paddingTop: "max(1rem, env(safe-area-inset-top))" }}>
      <div className="flex items-center justify-between px-2 pt-1">
        <Link href="/" onClick={onNavigate} className="text-[20px]" aria-label="Depeche home">
          <Wordmark />
        </Link>
        {onClose ? (
          <button type="button" onClick={onClose} aria-label="Close menu" className="-mr-2 p-2 text-mute">
            <CloseIcon />
          </button>
        ) : null}
      </div>
      <Link
        href="/"
        onClick={(e) => {
          e.preventDefault();
          onNewChat();
        }}
        className="press glass glass-pill flex h-12 items-center justify-center gap-2.5 px-4 text-[16px] font-medium"
      >
        <GlassCode seed="new chat" />
        <PlusIcon />
        <span>New chat</span>
      </Link>
      <Shortcuts place="sidebar" onChat isAdmin={isAdmin} className="-mb-1 flex-wrap" />
      <label data-part="search-chats" className="flex h-11 items-center gap-2 rounded-2xl bg-soft px-4 text-mute">
        <SearchIcon />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          aria-label="Search chats"
          className="h-full w-full bg-transparent text-[16px] text-fg outline-none placeholder:text-faint"
        />
      </label>

      {showArchived ? (
        <button
          type="button"
          onClick={() => setShowArchived(false)}
          className="press -mb-2 flex items-center gap-2 self-start rounded-full px-2 py-1 text-[15px] text-mute"
        >
          <BackIcon />
          <span>All chats</span>
        </button>
      ) : null}

      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1">
        {shown.map(([label, list]) => (
          <section key={label} className="mb-4">
            <h3 className="px-3 pb-1.5 pt-2 text-[12px] font-semibold uppercase tracking-[0.1em] text-mute">{label}</h3>
            <ul>
              {list.map((c) => (
                <li key={c.id} className="chat-row relative" data-active={c.id === activeId ? "" : undefined}>
                  <Link
                    href={`/c/${c.id}`}
                    prefetch={false}
                    onClick={onNavigate}
                    aria-current={c.id === activeId ? "page" : undefined}
                    className={`block truncate rounded-xl py-2.5 pl-3 pr-11 text-[16px] ${c.id === activeId ? "bg-soft font-medium" : "hover:bg-soft"}`}
                  >
                    {c.title}
                  </Link>
                  <span className="absolute inset-y-0 right-0.5 flex items-center">
                    <ChatMenu
                      chat={c}
                      userId={userId}
                      label={`Options for ${c.title}`}
                      className="chat-more rounded-full p-2 text-mute transition-opacity hover:text-fg"
                      onChange={change}
                      onDeleted={() => {
                        setArchived((list) => list && list.filter((x) => x.id !== c.id));
                        onChatDeleted(c.id);
                      }}
                    />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {hits.length ? (
          <section className="mb-4" aria-label="Found in messages">
            <h3 className="px-3 pb-1.5 pt-2 text-[12px] font-semibold uppercase tracking-[0.1em] text-mute">In messages</h3>
            <ul>
              {hits.map((h) => (
                <li key={h.chatId}>
                  <Link
                    href={`/c/${h.chatId}?m=${h.messageId}`}
                    prefetch={false}
                    onClick={onNavigate}
                    data-testid="message-hit"
                    aria-current={h.chatId === activeId ? "page" : undefined}
                    className={`block rounded-xl px-3 py-2.5 ${h.chatId === activeId ? "bg-soft" : "hover:bg-soft"}`}
                  >
                    <span className="block truncate text-[16px] font-medium">{byId.get(h.chatId)?.title}</span>
                    <span className="mt-0.5 line-clamp-2 break-words text-[14px] leading-snug text-mute">
                      {h.role === "assistant" ? "Reply: " : "You: "}
                      {marked(h.snippet, inMessages.query).map((p, i) =>
                        p.hit ? (
                          <mark key={i} className="bg-transparent font-semibold text-fg">
                            {p.text}
                          </mark>
                        ) : (
                          <span key={i}>{p.text}</span>
                        ),
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {needle && inMessages.busy && !hits.length ? (
          <p role="status" className="px-3 text-[15px] text-mute">
            Searching messages…
          </p>
        ) : null}
        {needle && !inMessages.busy && !titled && !hits.length ? (
          <p role="status" className="px-3 text-[15px] text-mute">
            {inMessages.failed ? "Couldn't search messages just now. Try again in a moment." : `No chats or messages match “${q.trim()}”.`}
          </p>
        ) : null}
        {showArchived ? (
          archived && !archived.length ? (
            <p className="px-3 pt-2 text-[15px] text-mute">No archived chats. Archive a chat from its three dots to put it away here; chats you haven&apos;t used for a month are still deleted, unless you keep all your chats in Account.</p>
          ) : !archived ? (
            <p className="px-3 pt-2 text-[15px] text-mute">Loading…</p>
          ) : null
        ) : (
          <>
            {!chats.length ? <p className="px-3 text-[15px] text-mute">Your chats will appear here.</p> : null}
            <button
              type="button"
              data-part="archived-link"
              onClick={() => setShowArchived(true)}
              className="mb-2 mt-1 flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-[15px] text-mute hover:bg-soft"
            >
              <ArchiveIcon />
              <span>Archived chats</span>
            </button>
          </>
        )}
      </div>

      <AccountMenu
        name={name}
        isAdmin={isAdmin}
        spent={spent}
        cap={cap}
        noLimit={noLimit}
        reportFrom={activeId ? `/c/${activeId}` : "/"}
        onNavigate={onNavigate}
      />
    </nav>
  );
}

/**
 * Words inside your messages, found on the server a moment after you stop typing. Only the latest
 * search's answer is shown, so a slow earlier one can't replace it.
 */
function useMessageSearch(q: string) {
  const query = q.replace(/\s+/g, " ").trim();
  const [state, setState] = useState<{ query: string; hits: ChatHit[] | null; failed: boolean }>({ query: "", hits: null, failed: false });
  const latest = useRef("");
  useEffect(() => {
    latest.current = query;
    if (query.length < 2) return;
    const t = setTimeout(async () => {
      try {
        const hits = await searchChats(query);
        if (latest.current === query) setState({ query, hits, failed: false });
      } catch {
        if (latest.current === query) setState({ query, hits: [], failed: true });
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query]);
  const searching = query.length >= 2;
  const current = searching && state.query === query;
  // While the next answer is on its way, the last one stays up (marked with its own words).
  return { query: state.query, hits: searching ? state.hits : null, failed: current && state.failed, busy: searching && !current };
}
