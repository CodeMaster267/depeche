"use client";

import { useActionState } from "react";
import { Button, Field, GoogleMark, Kept, Notice, keepOnError } from "@/components/ui";
import { EmailCodeForm } from "@/components/EmailCodeForm";
import { MIN_PASSWORD } from "@/lib/validate";
import { acceptWithPassword, acceptWithProof } from "./actions";

export function AcceptInvite({ token }: { token: string }) {
  const [pw, pwAction, pwPending] = useActionState(keepOnError(acceptWithPassword.bind(null, token)), undefined);
  const [proof, proofAction, proofPending] = useActionState(acceptWithProof.bind(null, token), undefined);

  if (proof?.sentTo) {
    return (
      <EmailCodeForm email={proof.sentTo}>
        Check <strong>{proof.sentTo}</strong>. Tap the link in the email to join, or type its code here.
      </EmailCodeForm>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <form action={proofAction} className="flex flex-col gap-3">
        <Button name="via" value="google" variant="secondary" disabled={proofPending}>
          <GoogleMark /> Join with Google
        </Button>
        <Button name="via" value="email" variant="secondary" disabled={proofPending}>
          Email me a link to join
        </Button>
        {proof?.error ? <Notice tone="error">{proof.error}</Notice> : null}
      </form>

      <div className="my-2 flex items-center gap-3 text-[13px] text-faint">
        <span className="h-px flex-1 bg-line" /> or choose a password <span className="h-px flex-1 bg-line" />
      </div>

      <form action={pwAction} className="flex flex-col gap-3">
        <Kept values={pw?.values}>
        <Field
          label="Username (optional)"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          hint="Lets you sign in without typing your email."
        />
        </Kept>
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD}
          required
          hint={`At least ${MIN_PASSWORD} characters.`}
        />
        {pw?.error ? <Notice tone="error">{pw.error}</Notice> : null}
        <Button disabled={pwPending}>{pwPending ? "Joining…" : "Join Depeche"}</Button>
      </form>
    </div>
  );
}
