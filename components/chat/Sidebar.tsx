"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Wordmark } from "@/components/Wordmark";
import { NavLink } from "@/components/Press";
import { GlassCode } from "@/components/Glass";
import type { ChatRow } from "@/lib/chat/thread";
import { searchChats } from "@/app/c/actions";
import { marked, type ChatHit } from "@/lib/chat/find";
import { CloseIcon, PlusIcon, SearchIcon } from "./icons";

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
  chats,
  activeId,
  name,
  isAdmin,
  spent,
  cap,
  onNavigate,
  onClose,
}: {
  chats: ChatRow[];
  activeId: string | null;
  name: string;
  isAdmin: boolean;
  spent: number;
  cap: number;
  onNavigate: () => void;
  onClose?: () => void;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const titled = useMemo(() => (needle ? chats.filter((c) => c.title.toLowerCase().includes(needle)) : chats), [chats, needle]);
  const shown = useMemo(() => (needle ? [["Chats", titled] as [string, ChatRow[]]].filter(([, l]) => l.length) : group(chats)), [chats, titled, needle]);
  const inMessages = useMessageSearch(q);
  // Chats whose title matched are already listed; the rest show the message that matched.
  const byId = useMemo(() => new Map(chats.map((c) => [c.id, c])), [chats]);
  const titledIds = useMemo(() => new Set(titled.map((c) => c.id)), [titled]);
  const hits = needle ? (inMessages.hits ?? []).filter((h) => byId.has(h.chatId) && !titledIds.has(h.chatId)) : [];
  const share = cap > 0 ? Math.min(1, spent / cap) : 1;

  return (
    <nav aria-label="Chats" className="flex h-full flex-col gap-4 px-4" style={{ paddingTop: "max(1rem, env(safe-area-inset-top))" }}>
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
        onClick={onNavigate}
        className="press glass glass-pill flex h-12 items-center justify-center gap-2.5 px-4 text-[16px] font-medium"
      >
        <GlassCode seed="new chat" />
        <PlusIcon />
        <span>New chat</span>
      </Link>
      <label className="flex h-11 items-center gap-2 rounded-2xl bg-soft px-4 text-mute">
        <SearchIcon />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          aria-label="Search chats"
          className="h-full w-full bg-transparent text-[16px] text-fg outline-none placeholder:text-faint"
        />
      </label>

      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1">
        {shown.map(([label, list]) => (
          <section key={label} className="mb-4">
            <h3 className="px-3 pb-1.5 pt-2 text-[12px] font-semibold uppercase tracking-[0.1em] text-mute">{label}</h3>
            <ul>
              {list.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/c/${c.id}`}
                    prefetch={false}
                    onClick={onNavigate}
                    aria-current={c.id === activeId ? "page" : undefined}
                    className={`block truncate rounded-xl px-3 py-2.5 text-[16px] ${c.id === activeId ? "bg-soft font-medium" : "hover:bg-soft"}`}
                  >
                    {c.title}
                  </Link>
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
        {needle && !inMessages.busy && !titled.length && !hits.length ? (
          <p role="status" className="px-3 text-[15px] text-mute">
            {inMessages.failed ? "Couldn't search messages just now. Try again in a moment." : `No chats or messages match “${q.trim()}”.`}
          </p>
        ) : null}
        {!chats.length ? <p className="px-3 text-[15px] text-mute">Your chats will appear here.</p> : null}
      </div>

      <div className="flex flex-col gap-3 border-t border-line pb-4 pt-4" style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}>
        <div className="flex items-center gap-3 px-2">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-inv text-[15px] font-semibold text-on-inv">
            {name.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[16px]">{name}</span>
            <span className="mt-1 flex flex-wrap gap-2 whitespace-nowrap text-[14px]">
              {isAdmin ? <NavLink href="/family">Family</NavLink> : null}
              <NavLink href="/memory">Memory</NavLink>
              <NavLink href="/account">Account</NavLink>
              <NavLink href={`/report?from=${encodeURIComponent(activeId ? `/c/${activeId}` : "/")}`}>Report a bug</NavLink>
            </span>
          </span>
        </div>
        <div className="px-2" data-testid="spending">
          <div className="h-1 overflow-hidden rounded-full bg-line">
            <div className="h-full bg-fg" style={{ width: `${share * 100}%` }} />
          </div>
          <div className="mt-1.5 flex justify-between font-mono text-[12px] text-mute">
            <span>${spent.toFixed(2)} this month</span>
            <span>limit ${cap.toFixed(0)}</span>
          </div>
        </div>
      </div>
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
