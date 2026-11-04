"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { ChevronDownIcon } from "@/components/chat/icons";

/**
 * On phones the page header can't fit a pill for every page (an admin has four), so it shows one
 * pill naming the page you're on, which opens a short list of the others. Wider screens keep the
 * row of pills (see AppHeader).
 */
export function PagesMenu({ pages }: { pages: { href: string; label: string }[] }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const current = pages.find((p) => path === p.href || path.startsWith(`${p.href}/`));

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

  return (
    <div ref={wrap} className="relative sm:hidden">
      <button
        ref={button}
        type="button"
        aria-label="Pages menu"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen(!open)}
        className="press nav-pill gap-1.5 px-3.5!"
      >
        <span>{current?.label ?? "Menu"}</span>
        <ChevronDownIcon className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <nav
          id={listId}
          aria-label="Pages"
          className="account-menu absolute right-0 top-full z-30 mt-2 flex w-48 flex-col rounded-2xl border border-line bg-bg p-1.5 shadow-[0_12px_40px_-12px_rgb(0_0_0/0.35)]"
        >
          {pages.map((p) => (
            <Link
              key={p.href}
              href={p.href}
              onClick={() => setOpen(false)}
              aria-current={p === current ? "page" : undefined}
              className="press flex h-11 items-center rounded-xl px-3 text-[15px] text-fg hover:bg-soft aria-[current=page]:bg-soft aria-[current=page]:font-medium"
            >
              {p.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
