"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button, Notice } from "@/components/ui";
import { MAX_MEMORY_CHARS } from "@/lib/chat/memory";
import { MAX_INSTRUCTION_CHARS, type PersonalInstructions } from "@/lib/chat/instructions";
import { addMemory, forgetAll, saveInstructions } from "./actions";

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

/**
 * "About you" and "How should Depeche answer": like ChatGPT's custom instructions. The fields are
 * controlled so what was typed stays put after saving (React would otherwise reset the form).
 */
export function InstructionsForm({ initial }: { initial: PersonalInstructions }) {
  const [state, action, pending] = useActionState(saveInstructions, undefined);
  const [about, setAbout] = useState(initial.about_me);
  const [style, setStyle] = useState(initial.answer_style);
  const [enabled, setEnabled] = useState(initial.enabled);
  return (
    <form action={action} className="flex flex-col gap-5" data-testid="personal-instructions">
      <InstructionBox
        name="about_me"
        label="About you"
        hint="What should Depeche know about you to give better answers?"
        placeholder="For example: I'm a GP in Manchester, I have two kids, and I'm learning Spanish."
        value={about}
        onChange={setAbout}
      />
      <InstructionBox
        name="answer_style"
        label="How should Depeche answer?"
        hint="Tone, length, format, language, anything you'd like every reply to follow."
        placeholder="For example: Keep it short, use British spelling, and skip the pleasantries."
        value={style}
        onChange={setStyle}
      />
      <label className="flex cursor-pointer items-center justify-between gap-4 rounded-2xl border border-line px-4 py-3">
        <span className="min-w-0">
          <span className="block text-[17px]">Use in every chat</span>
          <span className="block text-[13px] text-mute">Turn off to pause them without deleting what you wrote.</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          name="enabled"
          className="h-6 w-6 shrink-0 accent-[var(--color-fg)]"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
      </label>
      {state?.error ? <Notice tone="error">{state.error}</Notice> : state?.ok ? <Notice>{state.ok}</Notice> : null}
      <Button disabled={pending}>Save instructions</Button>
    </form>
  );
}

function InstructionBox({
  name,
  label,
  hint,
  placeholder,
  value,
  onChange,
}: {
  name: string;
  label: string;
  hint: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const left = MAX_INSTRUCTION_CHARS - value.length;
  return (
    <label className="flex flex-col gap-2">
      <span className="text-[15px] font-medium">{label}</span>
      <span className="text-[13px] text-mute">{hint}</span>
      <textarea
        name={name}
        rows={4}
        maxLength={MAX_INSTRUCTION_CHARS}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[7.5rem] resize-y rounded-2xl border border-line bg-bg px-4 py-3 text-[17px] leading-relaxed outline-none placeholder:text-faint focus:border-fg"
      />
      <span className={`self-end text-[13px] tabular-nums ${left < 100 ? "text-fg" : "text-faint"}`} aria-live="polite">
        {left < 300 ? `${left.toLocaleString("en-GB")} left` : ""}
      </span>
    </label>
  );
}
