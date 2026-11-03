"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Wordmark } from "@/components/Wordmark";
import { NavLink } from "@/components/Press";
import { GlassCode } from "@/components/Glass";
import type { ChatRow } from "@/lib/chat/thread";
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
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return group(needle ? chats.filter((c) => c.title.toLowerCase().includes(needle)) : chats);
  }, [chats, q]);
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
