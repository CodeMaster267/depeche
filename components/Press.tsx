"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, type ComponentProps } from "react";

/**
 * Tap feedback. Any element with the `press` class gets a short glitch flash the moment it is
 * pressed (red/cyan edge split and a small jolt), even on a quick tap on iPhone, where `:active`
 * barely shows. The flash is on the button's edges, never on its text. Reduced motion gets a plain
 * dip instead (see globals.css). On touch it waits a moment so scrolls don't set it off.
 */
export function PressFeedback() {
  useEffect(() => {
    const flash = (el: HTMLElement) => {
      el.removeAttribute("data-pressed");
      void el.offsetWidth; // restart the animation on repeated taps
      el.setAttribute("data-pressed", "");
    };
    // On touch screens the flash waits 90 ms, and a swipe or scroll cancels it, so a scroll that
    // happens to start on a button doesn't make it flash. A quick tap still flashes on release.
    let held: { el: HTMLElement; x: number; y: number; timer: number } | null = null;
    const release = () => {
      if (held) clearTimeout(held.timer);
      held = null;
    };
    const onDown = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.(".press");
      if (!(el instanceof HTMLElement) || el.matches(":disabled")) return;
      if (e.pointerType !== "touch") return flash(el);
      release();
      const timer = window.setTimeout(() => {
        flash(el);
        held = null;
      }, 90);
      held = { el, x: e.clientX, y: e.clientY, timer };
    };
    const onMove = (e: PointerEvent) => {
      if (held && Math.hypot(e.clientX - held.x, e.clientY - held.y) > 8) release();
    };
    const onUp = () => {
      if (!held) return;
      const { el } = held;
      release();
      flash(el);
    };
    const onEnd = (e: AnimationEvent) => {
      if (e.animationName === "press-glitch" || e.animationName === "press-dip") {
        (e.target as HTMLElement).removeAttribute("data-pressed");
      }
    };
    document.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerup", onUp, { passive: true });
    document.addEventListener("pointercancel", release, { passive: true });
    document.addEventListener("scroll", release, { passive: true, capture: true });
    document.addEventListener("animationend", onEnd);
    return () => {
      release();
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", release);
      document.removeEventListener("scroll", release, { capture: true });
      document.removeEventListener("animationend", onEnd);
    };
  }, []);
  return null;
}

/** Shown inside a link while the next page loads: a thin scanning bar under the label. */
function Pending() {
  const { pending } = useLinkStatus();
  return <span aria-hidden="true" className="nav-pending" data-on={pending ? "" : undefined} />;
}

/** A header link that looks like a button and shows it's working until the page arrives. */
export function NavLink({ className = "", children, ...props }: ComponentProps<typeof Link>) {
  const here = usePathname() === props.href;
  return (
    <Link {...props} aria-current={here ? "page" : undefined} className={`press nav-pill ${className}`}>
      {children}
      <Pending />
    </Link>
  );
}
