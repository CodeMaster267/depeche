"use client";

import { useActionState, useEffect, useRef } from "react";
import { Button, Notice } from "@/components/ui";
import { MAX_MEMORY_CHARS } from "@/lib/chat/memory";
import { addMemory, forgetAll } from "./actions";

export function AddMemoryForm() {
  const [state, action, pending] = useActionState(addMemory, undefined);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) form.current?.reset();
  }, [state]);
  return (
    <form ref={form} action={action} className="flex flex-col gap-3">
      <label className="flex flex-col gap-2">
        <span className="text-[15px] font-medium">Add something</span>
        <textarea
          name="content"
          rows={2}
          maxLength={MAX_MEMORY_CHARS}
          placeholder="For example: I'm vegetarian, and I like short answers."
          className="resize-none rounded-2xl border border-line bg-bg px-4 py-3 text-[17px] outline-none placeholder:text-faint focus:border-fg"
        />
      </label>
      {state?.error ? <Notice tone="error">{state.error}</Notice> : state?.ok ? <Notice>{state.ok}</Notice> : null}
      <Button disabled={pending}>Remember</Button>
    </form>
  );
}

export function ForgetAllButton() {
  return (
    <form
      action={forgetAll}
      onSubmit={(e) => {
        if (!confirm("Forget everything Depeche remembers about you? This can't be undone.")) e.preventDefault();
      }}
    >
      <button type="submit" className="text-[15px] text-mute underline underline-offset-4">
        Forget everything
      </button>
    </form>
  );
}
