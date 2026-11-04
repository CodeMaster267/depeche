"use client";

import { LockScreen } from "@/components/lock/LockScreen";

export function LockPage({ pinLength, passkeys, next }: { pinLength: number; passkeys: boolean; next: string }) {
  return (
    <LockScreen
      pinLength={pinLength}
      passkeys={passkeys}
      onUnlocked={() => {
        try {
          const now = String(Date.now());
          localStorage.setItem("dp_last_active", now);
          localStorage.setItem("dp_unlocked_at", now);
        } catch {}
        window.location.replace(next);
      }}
    />
  );
}
