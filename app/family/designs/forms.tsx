"use client";

import { useActionState } from "react";
import { Button, Notice } from "@/components/ui";
import { saveDesignSettings, saveMemberBuilds } from "@/app/design/actions";

/** The kill switch and the family's builds per month. */
export function DesignSettingsForm({ enabled, builds }: { enabled: boolean; builds: number }) {
  const [state, action, pending] = useActionState(saveDesignSettings, undefined);
  return (
    <form action={action} className="flex flex-col gap-3">
      <label className="flex cursor-pointer items-center justify-between gap-4 rounded-2xl border border-line px-4 py-3">
        <span className="min-w-0">
          <span className="block text-[17px]">Let people redesign their Depeche</span>
          <span className="block text-[13px] text-mute">Off stops every build and shows everyone standard Depeche, straight away.</span>
        </span>
        <input type="checkbox" role="switch" name="enabled" defaultChecked={enabled} className="h-6 w-6 shrink-0 accent-[var(--color-fg)]" />
      </label>
      <label className="flex items-center justify-between gap-4 rounded-2xl border border-line px-4 py-3">
        <span className="text-[17px]">Builds per person each month</span>
        <input
          name="builds"
          type="number"
          min={0}
          max={500}
          defaultValue={builds}
          aria-label="Builds per person each month"
          className="h-11 w-20 rounded-xl border border-line bg-bg px-3 text-right text-[17px] text-fg outline-none focus:border-fg"
        />
      </label>
      {state?.error ? <Notice tone="error">{state.error}</Notice> : state?.ok ? <Notice>{state.ok}</Notice> : null}
      <Button variant="secondary" disabled={pending}>
        Save
      </Button>
    </form>
  );
}

/** One person's builds per month; empty uses the family's number. */
export function MemberBuildsForm({ member, name, builds, familyBuilds }: { member: string; name: string; builds: number | null; familyBuilds: number }) {
  const [state, action, pending] = useActionState(saveMemberBuilds, undefined);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="member" value={member} />
      <input
        name="builds"
        type="number"
        min={0}
        max={500}
        defaultValue={builds ?? ""}
        placeholder={String(familyBuilds)}
        aria-label={`Builds a month for ${name}`}
        className="h-10 w-20 rounded-xl border border-line bg-bg px-3 text-right text-[16px] text-fg outline-none placeholder:text-faint focus:border-fg"
      />
      <button type="submit" disabled={pending} data-busy={pending ? "" : undefined} className="press h-10 rounded-xl border border-line px-3 text-[14px]">
        Save
      </button>
      <span className="text-[13px] text-mute">{state?.error ?? state?.ok ?? "Empty uses the family's number."}</span>
    </form>
  );
}
