"use client";

import { useActionState } from "react";
import { Button, Field, Kept, Notice, keepOnError } from "@/components/ui";
import { MIN_PASSWORD } from "@/lib/validate";
import { changePassword, saveProfile } from "./actions";

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
