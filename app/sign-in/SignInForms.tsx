"use client";

import { useActionState, useEffect, useState } from "react";
import { Button, Field, GoogleMark, Kept, Notice, keepOnError } from "@/components/ui";
import { EmailCodeForm } from "@/components/EmailCodeForm";
import { sendEmailLink, signInWithGoogle, signInWithPassword } from "./actions";
import { clearDrafts } from "@/lib/chat/composer";

/** Email link first, Google second, username and password one tap away (as in the approved design). */
export function SignInForms() {
  // Signed out: unsent drafts from the last person on this device go too.
  useEffect(() => clearDrafts(), []);
  const [mode, setMode] = useState<"email" | "password">("email");
  const [emailState, emailAction, emailPending] = useActionState(keepOnError(sendEmailLink), undefined);
  const [pwState, pwAction, pwPending] = useActionState(keepOnError(signInWithPassword), undefined);

  const sentTo = emailState?.sentTo;

  if (mode === "email" && sentTo) {
    return (
      <EmailCodeForm email={sentTo} onStartOver={() => location.reload()}>
        If <strong>{sentTo}</strong> has a Depeche account, a sign-in email is on its way. Tap the link in it, or type
        its code here.
      </EmailCodeForm>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {mode === "email" ? (
        <form action={emailAction} className="flex flex-col gap-3">
          <Kept values={emailState?.values}>
          <Field label="Email address" name="email" type="email" autoComplete="email" inputMode="email" required />
          </Kept>
          {emailState?.error ? <Notice tone="error">{emailState.error}</Notice> : null}
          <Button disabled={emailPending}>{emailPending ? "Sending…" : "Send me a sign-in link"}</Button>
        </form>
      ) : (
        <form action={pwAction} className="flex flex-col gap-3">
          <Kept values={pwState?.values}>
          <Field
            label="Username or email"
            name="identifier"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
          />
          </Kept>
          <Field label="Password" name="password" type="password" autoComplete="current-password" required />
          {pwState?.error ? <Notice tone="error">{pwState.error}</Notice> : null}
          <Button disabled={pwPending}>{pwPending ? "Signing in…" : "Sign in"}</Button>
          <p className="px-1 text-[13px] text-mute">Forgot your password? Your family admin can reset it.</p>
        </form>
      )}

      <form action={signInWithGoogle}>
        <Button variant="secondary">
          <GoogleMark /> Continue with Google
        </Button>
      </form>

      <Button type="button" variant="quiet" className="mt-2" onClick={() => setMode(mode === "email" ? "password" : "email")}>
        {mode === "email" ? "Use a username and password" : "Email me a sign-in link instead"}
      </Button>
    </div>
  );
}
