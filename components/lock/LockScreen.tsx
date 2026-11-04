"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Wordmark } from "@/components/Wordmark";
import { biometricName, canUseBiometrics, passkeyHere, unlockWithPasskey } from "@/lib/lock/client";

type Props = {
  pinLength: number;
  passkeys: boolean;
  onUnlocked: () => void;
};

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

/**
 * The lock screen: the wordmark, the PIN as dots, a big keypad (so the phone keyboard never
 * covers anything), and Face ID / Touch ID when this person set it up. Typing on a keyboard works
 * too. Shared by the /lock page and the cover the app puts up when it locks itself.
 */
export function LockScreen({ pinLength, passkeys, onUnlocked }: Props) {
  const [pin, setPinState] = useState("");
  const pinRef = useRef("");
  const setPin = useCallback((v: string) => {
    pinRef.current = v;
    setPinState(v);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [shake, setShake] = useState(0);
  const [bio, setBio] = useState<string | null>(null);
  const tried = useRef(false);

  const waiting = waitUntil > now;

  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting]);

  const submit = useCallback(
    async (value: string) => {
      setBusy(true);
      try {
        const res = await fetch("/api/lock/pin", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pin: value }),
        });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; waitSeconds?: number; signedOut?: boolean };
        if (body.ok) {
          onUnlocked();
          return;
        }
        if (body.signedOut) {
          window.location.assign("/sign-in");
          return;
        }
        setPin("");
        setError(body.error ?? "Something went wrong. Try again.");
        setShake((n) => n + 1);
        if (body.waitSeconds) {
          setNow(Date.now());
          setWaitUntil(Date.now() + body.waitSeconds * 1000);
        }
      } catch {
        setPin("");
        setError("Couldn't reach Depeche. Check your connection.");
      } finally {
        setBusy(false);
      }
    },
    [onUnlocked, setPin],
  );

  const press = useCallback(
    (d: string) => {
      if (busy || waiting) return;
      setError(null);
      const p = pinRef.current;
      if (p.length >= pinLength) return;
      const next = p + d;
      setPin(next);
      if (next.length === pinLength) void submit(next);
    },
    [busy, waiting, pinLength, submit, setPin],
  );
  const back = useCallback(() => setPin(pinRef.current.slice(0, -1)), [setPin]);

  const useBio = useCallback(async () => {
    setError(null);
    try {
      if (await unlockWithPasskey()) onUnlocked();
      else setError(`${bio ?? "Face ID"} didn't work. Use your PIN.`);
    } catch {
      // Cancelled, or the browser wanted a tap first. The button is right there.
    }
  }, [bio, onUnlocked]);

  // Offer Face ID / Touch ID when it's set up and this device can do it. If this very device made
  // the passkey, ask straight away (browsers that need a tap first just say no, quietly).
  useEffect(() => {
    if (!passkeys) return;
    void canUseBiometrics().then((ok) => {
      if (!ok) return;
      setBio(biometricName());
      if (passkeyHere() && !tried.current) {
        tried.current = true;
        void useBio();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [passkeys]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press, back]);

  const secondsLeft = Math.max(0, Math.ceil((waitUntil - now) / 1000));

  return (
    <main
      className="mx-auto flex min-h-full w-full max-w-[380px] flex-col items-center justify-center gap-6 px-7 py-10"
      style={{ paddingTop: "max(2.5rem, env(safe-area-inset-top))", paddingBottom: "max(2.5rem, env(safe-area-inset-bottom))" }}
      data-testid="lock-screen"
    >
      <h1 className="text-[40px]">
        <Wordmark />
      </h1>
      <p className="text-[17px] text-mute" id="lock-label">
        {waiting ? `Try again in ${secondsLeft}s` : "Enter your PIN"}
      </p>
      <div
        key={shake}
        className={`flex gap-4 ${shake ? "lock-shake" : ""}`}
        role="status"
        aria-labelledby="lock-label"
        aria-label={`${pin.length} of ${pinLength} digits entered`}
        data-testid="pin-dots"
      >
        {Array.from({ length: pinLength }, (_, i) => (
          <span key={i} className={`h-3.5 w-3.5 rounded-full border border-fg ${i < pin.length ? "bg-fg" : ""}`} />
        ))}
      </div>
      <p role="alert" className="min-h-[22px] text-center text-[15px] text-fg">
        {error ?? ""}
      </p>
      <div className="grid grid-cols-3 gap-x-6 gap-y-4" aria-label="Keypad">
        {KEYS.map((k) => (
          <Key key={k} label={k} onPress={() => press(k)} disabled={busy || waiting} />
        ))}
        {bio ? (
          <button
            type="button"
            onClick={useBio}
            className="press flex h-[72px] w-[72px] items-center justify-center rounded-full text-[13px] font-medium"
            aria-label={`Unlock with ${bio}`}
          >
            <FaceIcon />
          </button>
        ) : (
          <span />
        )}
        <Key label="0" onPress={() => press("0")} disabled={busy || waiting} />
        <button
          type="button"
          onClick={back}
          disabled={!pin.length || busy}
          className="press flex h-[72px] w-[72px] items-center justify-center rounded-full text-[15px] text-mute disabled:opacity-0"
          aria-label="Delete"
        >
          <svg aria-hidden="true" width="28" height="22" viewBox="0 0 28 22" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M9 1.5h16.5v19H9L1.5 11z" strokeLinejoin="round" />
            <path d="M13.5 7l8 8M21.5 7l-8 8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {bio ? (
        <button type="button" onClick={useBio} className="press text-[15px] underline underline-offset-4">
          Use {bio}
        </button>
      ) : null}
      <button
        type="button"
        onClick={async () => {
          await fetch("/api/lock/signout", { method: "POST" }).catch(() => null);
          window.location.assign("/sign-in");
        }}
        className="press text-[13px] text-mute underline underline-offset-4"
      >
        Forgot your PIN? Sign out
      </button>
      <p className="max-w-[300px] text-center text-[13px] text-faint">Signing back in unlocks Depeche, and you can choose a new PIN in Account.</p>
    </main>
  );
}

function Key({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      className="press flex h-[72px] w-[72px] items-center justify-center rounded-full border border-line text-[30px] font-light tabular-nums disabled:opacity-40"
    >
      {label}
    </button>
  );
}

function FaceIcon() {
  return (
    <svg aria-hidden="true" width="34" height="34" viewBox="0 0 34 34" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M2 10V6a4 4 0 0 1 4-4h4M24 2h4a4 4 0 0 1 4 4v4M32 24v4a4 4 0 0 1-4 4h-4M10 32H6a4 4 0 0 1-4-4v-4" />
      <path d="M11 12v3M23 12v3M17 12v7h-2M12 24c3 2.4 7 2.4 10 0" />
    </svg>
  );
}
