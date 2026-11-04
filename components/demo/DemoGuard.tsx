"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { signOutThisTab } from "@/app/sign-in/actions";
import { DEMO_COOKIE, DEMO_TAB_KEY } from "@/lib/auth/demo-meta";

/**
 * A demo (from a demo key) lasts only while the tab that typed the key stays open. That tab keeps
 * a mark in sessionStorage, which the browser drops when the tab closes; any other tab, or the
 * same one reopened later, signs out. While the demo runs, a line at the top says so.
 */
export function DemoGuard() {
  const [inDemo, setInDemo] = useState(false);
  // The layout stays put across pages, so check again on each one (the demo starts on a page change).
  const path = usePathname();
  useEffect(() => {
    if (!document.cookie.split("; ").some((c) => c === `${DEMO_COOKIE}=1`)) return;
    let mine = false;
    try {
      mine = sessionStorage.getItem(DEMO_TAB_KEY) === "1";
    } catch {}
    if (!mine) {
      document.cookie = `${DEMO_COOKIE}=; path=/; max-age=0`;
      void signOutThisTab().catch(() => location.assign("/sign-in"));
      return;
    }
    let seen = false;
    try {
      seen = sessionStorage.getItem(DEMO_TAB_KEY + "_seen") === "1";
    } catch {}
    setInDemo(!seen);
  }, [path]);
  if (!inDemo) return null;
  return (
    <div
      role="status"
      data-testid="demo-notice"
      className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-3 bg-fg px-4 py-2 text-[14px] text-bg"
      style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
    >
      <span>Demo: when you close this tab you won&apos;t be able to sign in again unless you have another demo key.</span>
      <button
        type="button"
        className="press shrink-0 rounded-lg border border-bg px-3 py-1 font-medium"
        onClick={() => {
          try {
            sessionStorage.setItem(DEMO_TAB_KEY + "_seen", "1");
          } catch {}
          setInDemo(false);
        }}
      >
        OK
      </button>
    </div>
  );
}
