"use client";

import { useActionState, useState } from "react";
import { Button, Notice, keepOnError } from "@/components/ui";
import { sendReport } from "./actions";

const MAX = 2000;

export function ReportForm({ from }: { from: string }) {
  const [state, action, pending] = useActionState(keepOnError(sendReport), undefined);
  const [length, setLength] = useState(0);
  // After a report is sent, a fresh empty box; after an error, what the person wrote is kept.
  const kept = state?.values?.body ?? "";
  return (
    <form action={action} onSubmit={() => setLength(0)} className="flex flex-col gap-3">
      <input type="hidden" name="from" value={from} />
      <label className="flex flex-col gap-1.5">
        <span className="sr-only">What went wrong?</span>
        <textarea
          key={state?.sent ?? "draft"}
          name="body"
          aria-label="What went wrong?"
          placeholder="What went wrong? What did you expect to happen instead?"
          required
          minLength={10}
          maxLength={MAX}
          rows={6}
          defaultValue={kept}
          onInput={(e) => setLength(e.currentTarget.value.length)}
          className="min-h-40 w-full resize-y rounded-2xl border border-line bg-bg px-4 py-3.5 text-[17px] leading-snug text-fg outline-none placeholder:text-faint focus:border-fg"
        />
        <span className="flex justify-between gap-3 px-1 text-[13px] text-mute">
          <span>Please leave out anything private.</span>
          <span className="font-mono tabular-nums">
            {length || kept.length}/{MAX}
          </span>
        </span>
      </label>
      {state?.error ? <Notice tone="error">{state.error}</Notice> : state?.ok ? <Notice>{state.ok}</Notice> : null}
      <Button disabled={pending}>Send report</Button>
    </form>
  );
}
