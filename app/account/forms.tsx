"use client";

import { useActionState, useState, useTransition } from "react";
import { Button, Field, Kept, Notice, keepOnError } from "@/components/ui";
import { MIN_PASSWORD } from "@/lib/validate";
import { changePassword, saveProfile, setKeepChats } from "./actions";

export function ProfileForm({ name, username }: { name: string; username: string }) {
  const [state, action, pending] = useActionState(keepOnError(saveProfile), undefined);
  return (
    <form action={action} className="flex flex-col gap-3">
      <Kept values={state?.values}>
      <Field label="Your name" name="name" defaultValue={name} autoComplete="name" required />
      <Field
        label="Username"
        name="username"
        defaultValue={username}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        hint="Optional. Letters, numbers, dots, dashes, underscores."
      />
      </Kept>
      {state?.error ? <Notice tone="error">{state.error}</Notice> : state?.ok ? <Notice>{state.ok}</Notice> : null}
      <Button disabled={pending}>Save</Button>
    </form>
  );
}

export function PasswordForm() {
  const [state, action, pending] = useActionState(changePassword, undefined);
  return (
    <form action={action} className="flex flex-col gap-3">
      <Field label="New password" name="password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD} required />
      {state?.error ? <Notice tone="error">{state.error}</Notice> : state?.ok ? <Notice>{state.ok}</Notice> : null}
      <Button variant="secondary" disabled={pending}>Set password</Button>
    </form>
  );
}

/** A switch: chats unused for a month are deleted unless this is on. Pinned chats always stay. */
export function KeepChatsToggle({ keep: initial }: { keep: boolean }) {
  const [keep, setKeep] = useState(initial);
  const [pending, start] = useTransition();
  return (
    <div className="flex items-start justify-between gap-4">
      <p className="text-[15px] text-mute" id="keep-chats-help">
        {keep
          ? "Your chats are kept until you delete them."
          : "Chats you haven't used for a month are deleted, along with their files. Pinned chats are always kept."}
      </p>
      <button
        type="button"
        role="switch"
        aria-checked={keep}
        aria-label="Keep all my chats"
        aria-describedby="keep-chats-help"
        disabled={pending}
        onClick={() => {
          const next = !keep;
          setKeep(next);
          start(() => setKeepChats(next));
        }}
        className={`relative h-8 w-[52px] shrink-0 rounded-full border transition-colors disabled:opacity-60 ${keep ? "border-fg bg-fg" : "border-line bg-soft"}`}
      >
        <span
          className={`absolute top-[3px] h-6 w-6 rounded-full shadow transition-[left] ${keep ? "left-[24px] bg-bg" : "left-[3px] bg-fg"}`}
        />
      </button>
    </div>
  );
}
