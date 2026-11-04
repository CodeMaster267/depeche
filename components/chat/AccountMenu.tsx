"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { BrushIcon, BugIcon, ChevronUpDownIcon, MemoryIcon, PeopleIcon, SkillsIcon, PersonIcon, PulseIcon } from "./icons";

/** A thin bar under the row while its page loads, like the header links. */
function Pending() {
  const { pending } = useLinkStatus();
  return <span aria-hidden="true" className="nav-pending" data-on={pending ? "" : undefined} />;
}

function Item({ href, icon, children, onGo }: { href: string; icon: ReactNode; children: ReactNode; onGo: () => void }) {
  const here = usePathname() === href.split("?")[0];
  return (
    <Link
      href={href}
      onClick={onGo}
      aria-current={here ? "page" : undefined}
      className="press relative flex h-11 items-center gap-3 overflow-hidden rounded-xl px-3 text-[15px] text-fg hover:bg-soft aria-[current=page]:bg-soft aria-[current=page]:font-medium"
    >
      <span className="text-mute">{icon}</span>
      <span>{children}</span>
      <Pending />
    </Link>
  );
}

/**
 * The foot of the chats list: one quiet row with your initial, your name and what you've spent this
 * month. Tapping it opens a small menu above it with your pages (Memory, Skills, My look, Account), the
 * family pages for admins, and Report a bug. Replaces the wall of pill buttons that used to sit
 * beside the name.
 */
export function AccountMenu({
  name,
  isAdmin,
  spent,
  cap,
  noLimit = false,
  reportFrom,
  onNavigate,
}: {
  name: string;
  isAdmin: boolean;
  spent: number;
  cap: number;
  /** Their family admin took the monthly limit away. */
  noLimit?: boolean;
  /** The page Report a bug comes back to. */
  reportFrom: string;
  onNavigate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const share = noLimit ? 0 : cap > 0 ? Math.min(1, spent / cap) : 1;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const go = () => {
    setOpen(false);
    onNavigate();
  };

  return (
    <div ref={wrap} className="relative border-t border-line pt-3" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
      {open ? (
        <div
          id={panelId}
          data-part="account-menu"
          className="account-menu absolute inset-x-0 bottom-full z-20 mb-2 rounded-2xl border border-line bg-bg p-1.5 shadow-[0_12px_40px_-12px_rgb(0_0_0/0.35)]"
        >
          <nav aria-label="Your pages" className="flex flex-col">
            <Item href="/memory" icon={<MemoryIcon />} onGo={go}>
              Memory
            </Item>
            <Item href="/skills" icon={<SkillsIcon />} onGo={go}>
              Skills
            </Item>
            <Item href="/design" icon={<BrushIcon />} onGo={go}>
              My look
            </Item>
            <Item href="/gadgets" icon={<GadgetIcon />} onGo={go}>
              Gadgets
            </Item>
            <Item href="/account" icon={<PersonIcon />} onGo={go}>
              Account
            </Item>
            {isAdmin ? (
              <>
                <span aria-hidden="true" className="mx-3 my-1.5 h-px bg-line" />
                <Item href="/family" icon={<PeopleIcon />} onGo={go}>
                  Family
                </Item>
                <Item href="/health" icon={<PulseIcon />} onGo={go}>
                  Health
                </Item>
              </>
            ) : null}
            <span aria-hidden="true" className="mx-3 my-1.5 h-px bg-line" />
            <span data-part="report-link" className="contents">
              <Item href={`/report?from=${encodeURIComponent(reportFrom)}`} icon={<BugIcon />} onGo={go}>
                Report a bug
              </Item>
            </span>
          </nav>
          <div className="mx-3 mb-2 mt-2 border-t border-line pt-3" data-testid="spending" data-part="spending">
            <div className="h-1 overflow-hidden rounded-full bg-line">
              <div className="h-full bg-fg" style={{ width: `${share * 100}%` }} />
            </div>
            <div className="mt-1.5 flex justify-between font-mono text-[12px] text-mute">
              <span>${spent.toFixed(2)} this month</span>
              <span>{noLimit ? "no limit" : `limit $${cap.toFixed(0)}`}</span>
            </div>
          </div>
        </div>
      ) : null}
      <button
        ref={button}
        type="button"
        aria-label={`${name}, account menu`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(!open)}
        className="press flex w-full items-center gap-3 rounded-2xl px-2 py-2 text-left hover:bg-soft aria-expanded:bg-soft"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-inv text-[14px] font-semibold text-on-inv">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium leading-tight">{name}</span>
          <span className="mt-0.5 block font-mono text-[12px] leading-tight text-mute">
            {noLimit ? `$${spent.toFixed(2)} this month · no limit` : `$${spent.toFixed(2)} of $${cap.toFixed(0)} this month`}
          </span>
        </span>
        <span className="text-mute">
          <ChevronUpDownIcon className="h-[18px] w-[18px]" />
        </span>
      </button>
    </div>
  );
}

/** Gadgets: a small grid of four squares, one rounded (an app). */
const GadgetIcon = ({ className = "h-[18px] w-[18px]" }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="3.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </svg>
);
