"use client";

import { useActionState } from "react";
import { Button, Field, GoogleMark, Kept, Notice, keepOnError } from "@/components/ui";
import { EmailCodeForm } from "@/components/EmailCodeForm";
import { startSetup } from "./actions";

export function SetupForm() {
  const [state, action, pending] = useActionState(keepOnError(startSetup), undefined);
  if (state?.sentTo) {
    return (
      <EmailCodeForm email={state.sentTo}>
        Check <strong>{state.sentTo}</strong>. Tap the link in the email to finish, or type its code here.
      </EmailCodeForm>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-3">
      <Kept values={state?.values}>
      <Field label="Your name" name="name" autoComplete="name" required />
      <Field label="Your family's name" name="family" required />
      <Field label="Your email (the owner's)" name="email" type="email" autoComplete="email" required />
      </Kept>
      {state?.error ? <Notice tone="error">{state.error}</Notice> : null}
      <Button name="via" value="email" disabled={pending}>
        Email me a link to finish
      </Button>
      <Button name="via" value="google" variant="secondary" disabled={pending}>
        <GoogleMark /> Finish with Google
      </Button>
    </form>
  );
}
