"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, type ComponentProps } from "react";

/**
 * Tap feedback. Any element with the `press` class gets a short glitch flash the moment it is
 * pressed (red/cyan edge split and a small jolt), even on a quick tap on iPhone, where `:active`
 * barely shows. The flash is on the button's edges, never on its text. Reduced motion gets a plain
 * dip instead (see globals.css).
 */
export function PressFeedback() {
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.(".press");
      if (!(el instanceof HTMLElement) || el.matches(":disabled")) return;
      el.removeAttribute("data-pressed");
      void el.offsetWidth; // restart the animation on repeated taps
      el.setAttribute("data-pressed", "");
    };
    const onEnd = (e: AnimationEvent) => {
      if (e.animationName === "press-glitch" || e.animationName === "press-dip") {
        (e.target as HTMLElement).removeAttribute("data-pressed");
      }
    };
    document.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("animationend", onEnd);
    return () => {
      document.removeEventListener("pointerdown", onDown);
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
