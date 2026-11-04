"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { LockScreen } from "./LockScreen";
import { readLockSettings, type LockSettings } from "@/lib/lock/client";

const LAST_ACTIVE = "dp_last_active";
const UNLOCKED_AT = "dp_unlocked_at";
const ACTIVITY = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
const SKIP = ["/lock", "/sign-in", "/setup", "/invite/", "/auth/"];

const store = {
  get(k: string) {
    try {
      return Number(localStorage.getItem(k) ?? 0);
    } catch {
      return 0;
    }
  },
  set(k: string, v: number) {
    try {
      localStorage.setItem(k, String(v));
    } catch {}
  },
};

/**
 * Locks the app after the time the person chose without use, or as soon as they leave it.
 * When it locks, a lock screen covers everything (what's underneath is kept, so a half-written
 * message is still there after unlocking) and the server is told, so nothing else gets through
 * until the PIN or Face ID unlocks it again. Does nothing for people without a lock.
 */
export function LockGuard() {
  const path = usePathname();
  const [settings, setSettings] = useState<LockSettings | null>(null);
  const [locked, setLocked] = useState(false);
  const lastTouch = useRef(0);
  const hiddenAt = useRef(0);
  const skip = SKIP.some((p) => path === p || path.startsWith(p));

  useEffect(() => {
    const read = () => setSettings(readLockSettings());
    read();
    // Settings can change (in Account, or on another device); pick them up when the page comes back.
    document.addEventListener("visibilitychange", read);
    return () => document.removeEventListener("visibilitychange", read);
  }, [path]);

  const lock = useCallback(() => {
    setLocked(true);
    try {
      navigator.sendBeacon("/api/lock/lock");
    } catch {
      void fetch("/api/lock/lock", { method: "POST", keepalive: true }).catch(() => null);
    }
  }, []);

  // The server let this page through, so it's unlocked as of now.
  useEffect(() => {
    if (!settings || skip) return;
    store.set(LAST_ACTIVE, Date.now());
  }, [settings, skip]);

  useEffect(() => {
    if (!settings || skip || locked) return;
    const limit = settings.timeout * 1000;
    // How often the page tells the server it's still in use (the server's unlock runs out without it).
    const touchEvery = Math.min(60_000, Math.max(15_000, (settings.timeout || 120) * 333));

    const touch = async () => {
      lastTouch.current = Date.now();
      const res = await fetch("/api/lock/touch", { method: "POST" }).catch(() => null);
      const body = (await res?.json().catch(() => null)) as { locked?: boolean } | null;
      if (body?.locked) setLocked(true);
    };
    const active = () => {
      const now = Date.now();
      if (now - store.get(LAST_ACTIVE) > 2000) store.set(LAST_ACTIVE, now);
      if (now - lastTouch.current > touchEvery) void touch();
    };
    const expired = () => settings.timeout > 0 && Date.now() - store.get(LAST_ACTIVE) >= limit;
    const tick = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (expired()) lock();
      // "As soon as I leave" has no idle timer, so keep the server's unlock alive while it's open.
      else if (settings.timeout === 0 && Date.now() - lastTouch.current > touchEvery) void touch();
    }, 5000);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt.current = Date.now();
        if (settings.timeout === 0) lock();
      } else if (expired()) {
        lock();
      } else {
        void touch();
      }
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted && (settings.timeout === 0 || expired())) lock();
    };
    for (const ev of ACTIVITY) window.addEventListener(ev, active, { passive: true, capture: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onShow);
    return () => {
      clearInterval(tick);
      for (const ev of ACTIVITY) window.removeEventListener(ev, active, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onShow);
    };
  }, [settings, skip, locked, lock]);

  // Unlocking in another tab unlocks this one too (the server is asked, not trusted blindly).
  useEffect(() => {
    if (!locked) return;
    const onStorage = async (e: StorageEvent) => {
      if (e.key !== UNLOCKED_AT) return;
      const res = await fetch("/api/lock/touch", { method: "POST" }).catch(() => null);
      const body = (await res?.json().catch(() => null)) as { locked?: boolean } | null;
      if (body && !body.locked) unlocked();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked]);

  // While locked, everything else on the page is unreachable (no tabbing or screen reader into it).
  useEffect(() => {
    if (!locked) return;
    const others = Array.from(document.body.children).filter((el) => el.id !== "app-lock") as HTMLElement[];
    for (const el of others) el.inert = true;
    const html = document.documentElement;
    const overflow = html.style.overflow;
    html.style.overflow = "hidden";
    return () => {
      for (const el of others) el.inert = false;
      html.style.overflow = overflow;
    };
  }, [locked]);

  function unlocked() {
    const now = Date.now();
    store.set(LAST_ACTIVE, now);
    store.set(UNLOCKED_AT, now);
    lastTouch.current = now;
    setLocked(false);
  }

  if (!locked || !settings || skip) return null;
  return (
    <div id="app-lock" role="dialog" aria-modal="true" aria-label="Depeche is locked" className="fixed inset-0 z-[1000] overflow-y-auto bg-bg text-fg">
      <LockScreen pinLength={settings.pinLength} passkeys={settings.passkeys} onUnlocked={unlocked} />
    </div>
  );
}
