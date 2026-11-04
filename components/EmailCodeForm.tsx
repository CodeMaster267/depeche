"use client";

import { useActionState, type ReactNode } from "react";
import { Button, Field, Notice } from "@/components/ui";
import { verifyEmailCode } from "@/app/sign-in/actions";

/**
 * After an email has been sent: tap the link in it, or type its code here. The code is what works
 * in the iPhone home-screen app, where links from Mail open in Safari instead.
 */
export function EmailCodeForm({ email, children, onStartOver }: { email: string; children: ReactNode; onStartOver?: () => void }) {
  const [state, action, pending] = useActionState(verifyEmailCode, undefined);
  return (
    <form action={action} className="flex flex-col gap-3">
      <Notice>{children}</Notice>
      <p className="px-1 text-[14px] text-mute" data-testid="check-spam">
        Not there after a minute? Look in your spam or junk folder too.
      </p>
      <input type="hidden" name="email" value={email} />
      <Field label="Code from the email" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={10} required />
      {state?.error ? <Notice tone="error">{state.error}</Notice> : null}
      <Button disabled={pending}>{pending ? "Checking…" : "Continue"}</Button>
      {onStartOver ? (
        <Button type="button" variant="quiet" onClick={onStartOver}>
          Use a different email
        </Button>
      ) : null}
    </form>
  );
}
