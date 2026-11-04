"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { Button, Field, Notice } from "@/components/ui";
import { biometricName, canUseBiometrics, createPasskey, deviceName, markPasskeyHere } from "@/lib/lock/client";
import { addPasskey, passkeyOptions, removePasskey, savePin, setLockTimeout, turnOffLock, type LockState } from "./lock-actions";

const TIMEOUT_LABELS: [number, string][] = [
  [0, "As soon as I leave Depeche"],
  [60, "After 1 minute"],
  [300, "After 5 minutes"],
  [900, "After 15 minutes"],
  [3600, "After 1 hour"],
];

type Passkey = { id: string; label: string; created_at: string; last_used_at: string | null };

const pinProps = {
  type: "password",
  inputMode: "numeric" as const,
  pattern: "\\d{4,8}",
  minLength: 4,
  maxLength: 8,
  autoComplete: "off",
  required: true,
};

/** Account → App lock: a PIN, when to lock, and Face ID / Touch ID per device. */
export function AppLock({ on, timeout, needsCurrent, passkeys }: { on: boolean; timeout: number; needsCurrent: boolean; passkeys: Passkey[] }) {
  if (!on) return <TurnOn />;
  return (
    <div className="flex flex-col gap-5">
      <p className="text-[15px] text-mute" data-testid="lock-status">
        <span className="text-fg">App lock is on.</span> Depeche asks for your PIN{" "}
        {timeout === 0 ? "every time you come back to it" : "when you haven't used it for a while"}, on all your devices.
      </p>
      <TimeoutPicker timeout={timeout} />
      <Biometrics passkeys={passkeys} />
      <details className="rounded-2xl border border-line px-4 py-3">
        <summary className="cursor-pointer text-[17px]">Change PIN</summary>
        <PinForm needsCurrent={needsCurrent} label="Change PIN" />
      </details>
      <details className="rounded-2xl border border-line px-4 py-3">
        <summary className="cursor-pointer text-[17px]">Turn off app lock</summary>
        <TurnOff needsCurrent={needsCurrent} />
      </details>
    </div>
  );
}

function TurnOn() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[15px] text-mute">
        Ask for a PIN (or Face ID) to open Depeche on your devices, so someone picking up your phone can&apos;t read your
        chats.
      </p>
      <PinForm needsCurrent={false} label="Turn on app lock" withTimeout />
    </div>
  );
}

function PinForm({ needsCurrent, label, withTimeout = false }: { needsCurrent: boolean; label: string; withTimeout?: boolean }) {
  const [state, action, pending] = useActionState(savePin, undefined);
  // Marks the form ready once the page is interactive (the browser tests wait for it).
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return (
    <form action={action} className="mt-3 flex flex-col gap-3" data-ready={ready ? "" : undefined}>
      {needsCurrent ? <Field label="Current PIN" name="current" {...pinProps} /> : null}
      <Field label="New PIN (4 to 8 digits)" name="pin" {...pinProps} />
      <Field label="Type the new PIN again" name="confirm" {...pinProps} />
      {withTimeout ? (
        <label className="flex flex-col gap-1.5">
          <span className="px-1 text-[13px] text-mute">Lock Depeche</span>
          <Select name="timeout" defaultValue={300} />
        </label>
      ) : null}
      <Result state={state} />
      <Button disabled={pending}>{label}</Button>
    </form>
  );
}

function Select(props: { name?: string; defaultValue?: number; value?: number; onChange?: (v: number) => void; disabled?: boolean }) {
  return (
    <select
      name={props.name}
      aria-label="Lock Depeche"
      defaultValue={props.defaultValue}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange?.(Number(e.target.value))}
      className="h-14 w-full appearance-none rounded-2xl border border-line bg-bg px-4 text-[17px] text-fg outline-none focus:border-fg"
    >
      {TIMEOUT_LABELS.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

function TimeoutPicker({ timeout }: { timeout: number }) {
  const [value, setValue] = useState(timeout);
  const [state, setState] = useState<LockState>();
  const [pending, start] = useTransition();
  return (
    <label className="flex flex-col gap-1.5">
      <span className="px-1 text-[13px] text-mute">Lock Depeche</span>
      <Select
        value={value}
        disabled={pending}
        onChange={(v) => {
          setValue(v);
          start(async () => setState(await setLockTimeout(v)));
        }}
      />
      {state?.error ? <Notice tone="error">{state.error}</Notice> : null}
    </label>
  );
}

function Biometrics({ passkeys }: { passkeys: Passkey[] }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [name, setName] = useState("Face ID");
  const [state, setState] = useState<LockState>();
  const [pending, start] = useTransition();

  useEffect(() => {
    setName(biometricName());
    void canUseBiometrics().then(setAvailable);
  }, []);

  const setUp = () =>
    start(async () => {
      setState(undefined);
      const res = await passkeyOptions();
      if ("error" in res) return setState({ error: res.error });
      try {
        const made = await createPasskey(res.options);
        const saved = await addPasskey(made, deviceName());
        if (saved?.ok) markPasskeyHere(true);
        setState(saved);
      } catch (e) {
        const n = (e as Error).name;
        setState({
          error:
            n === "InvalidStateError"
              ? `${name} is already set up on this device.`
              : n === "NotAllowedError"
                ? "Cancelled."
                : `Couldn't set up ${name}. Try again.`,
        });
      }
    });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[15px] text-mute">
        Unlock with {name} instead of typing your PIN. Your face or fingerprint never leaves your device; Depeche only
        keeps a key that can&apos;t unlock anything else.
      </p>
      {passkeys.length ? (
        <ul className="flex flex-col gap-2" data-testid="passkeys">
          {passkeys.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 rounded-2xl border border-line px-4 py-3">
              <span className="min-w-0">
                <span className="block text-[17px]">{p.label}</span>
                <span className="block text-[13px] text-mute">
                  Added {new Date(p.created_at).toLocaleDateString()}
                  {p.last_used_at ? ` · last used ${new Date(p.last_used_at).toLocaleDateString()}` : ""}
                </span>
              </span>
              <button
                type="button"
                className="press shrink-0 text-[15px] underline underline-offset-4"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await removePasskey(p.id);
                    if (r?.ok && passkeys.length === 1) markPasskeyHere(false);
                    setState(r);
                  })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {available === false ? (
        <p className="text-[13px] text-mute">This browser can&apos;t use Face ID or Touch ID. Your PIN still works.</p>
      ) : (
        <Button variant="secondary" type="button" onClick={setUp} disabled={pending || available === null}>
          {`Set up ${name} on this device`}
        </Button>
      )}
      <Result state={state} />
    </div>
  );
}

function TurnOff({ needsCurrent }: { needsCurrent: boolean }) {
  const [state, action, pending] = useActionState(turnOffLock, undefined);
  return (
    <form
      action={async (form) => {
        markPasskeyHere(false);
        action(form);
      }}
      className="mt-3 flex flex-col gap-3"
    >
      {needsCurrent ? <Field label="Current PIN" name="current" {...pinProps} /> : null}
      <p className="text-[15px] text-mute">Depeche will open without a PIN on all your devices, and forget Face ID and Touch ID.</p>
      <Result state={state} />
      <Button variant="secondary" disabled={pending}>
        Turn off app lock
      </Button>
    </form>
  );
}

function Result({ state }: { state: LockState }) {
  if (state?.error) return <Notice tone="error">{state.error}</Notice>;
  if (state?.ok) return <Notice>{state.ok}</Notice>;
  return null;
}
