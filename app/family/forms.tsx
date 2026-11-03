"use client";

import { useActionState, useEffect, useState } from "react";
import { Button, Field, Kept, Notice, keepOnError } from "@/components/ui";
import { MIN_PASSWORD } from "@/lib/validate";
import {
  createFamily,
  inviteMember,
  removeProviderKey,
  resetPassword,
  revokeInvite,
  saveProviderKey,
  setCap,
  type ActionState,
} from "./actions";

/** Shows a fresh invite link with Copy and, where the device supports it, Share. */
function InviteLink({ state }: { state: ActionState }) {
  const [copied, setCopied] = useState(false);
  if (state?.error) return <Notice tone="error">{state.error}</Notice>;
  if (!state?.link) return null;
  const link = state.link;
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-soft p-4">
      <p className="text-[15px]">{state.ok}</p>
      <code className="block break-all font-mono text-[13px]" data-testid="invite-link">
        {link}
      </code>
      <div className="flex gap-3">
        <Button
          type="button"
          variant="secondary"
          className="h-11"
          onClick={async () => {
            await navigator.clipboard.writeText(link);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </Button>
        {typeof navigator !== "undefined" && "share" in navigator ? (
          <Button
            type="button"
            variant="secondary"
            className="h-11"
            onClick={() => navigator.share({ title: "Join Depeche", url: link }).catch(() => {})}
          >
            Share
          </Button>
        ) : null}
      </div>
      <p className="text-[13px] text-mute">Anyone with this link can join as that person, so send it only to them.</p>
    </div>
  );
}

export function InviteForm() {
  const [state, action, pending] = useActionState(keepOnError(inviteMember), undefined);
  return (
    <form action={action} className="flex flex-col gap-3">
      <Kept values={state?.values}>
        <Field label="Their name" name="name" required />
        <Field label="Their email" name="email" type="email" required />
      </Kept>
      <Button disabled={pending}>{pending ? "Creating…" : "Create invite link"}</Button>
      <InviteLink state={state} />
    </form>
  );
}

export function CreateFamilyForm() {
  const [state, action, pending] = useActionState(keepOnError(createFamily), undefined);
  return (
    <form action={action} className="flex flex-col gap-3">
      <Kept values={state?.values}>
        <Field label="Family name" name="family" required />
        <Field label="Admin's name" name="name" required />
        <Field label="Admin's email" name="email" type="email" required />
      </Kept>
      <Button variant="secondary" disabled={pending}>
        {pending ? "Creating…" : "Create family and invite its admin"}
      </Button>
      <InviteLink state={state} />
    </form>
  );
}

export function RevokeButton({ id }: { id: string }) {
  return (
    <form action={revokeInvite.bind(null, id)}>
      <button className="shrink-0 text-[15px] text-mute underline underline-offset-4">Cancel</button>
    </form>
  );
}

type Member = { id: string; display_name: string; username: string | null; role: string; monthly_cap_usd: string };

export function MemberRow({ member, spent, isMe }: { member: Member; spent: number; isMe: boolean }) {
  const [open, setOpen] = useState(false);
  const [capState, capAction, capPending] = useActionState(keepOnError(setCap.bind(null, member.id)), undefined);
  const [pwState, pwAction, pwPending] = useActionState(resetPassword.bind(null, member.id), undefined);
  const cap = Number(member.monthly_cap_usd);

  return (
    <li className="flex flex-col gap-3 px-4 py-3">
      <button type="button" className="flex items-center justify-between gap-3 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="min-w-0">
          <span className="block truncate text-[17px]">
            {member.display_name}
            {isMe ? <span className="text-mute"> (you)</span> : null}
          </span>
          <span className="block truncate text-[13px] text-mute">
            {member.role === "admin" ? "Admin" : "Member"}
            {member.username ? ` · @${member.username}` : ""}
          </span>
        </span>
        <span className="shrink-0 text-right text-[15px] tabular-nums">
          ${spent.toFixed(2)} <span className="text-mute">of ${cap.toFixed(0)}</span>
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-4 pb-2">
          <form action={capAction} className="flex flex-col gap-2">
            <Kept values={capState?.values}>
            <Field label="Monthly limit in dollars" name="cap" inputMode="decimal" defaultValue={cap.toFixed(2)} hint="Monthly limit in dollars. Chats stop when it's reached." />
            </Kept>
            {capState?.error ? <Notice tone="error">{capState.error}</Notice> : capState?.ok ? <Notice>{capState.ok}</Notice> : null}
            <Button variant="secondary" disabled={capPending}>Save limit</Button>
          </form>
          {!isMe ? (
            <form action={pwAction} className="flex flex-col gap-2">
              <Field label="New password for them" name="password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD} />
              {pwState?.error ? <Notice tone="error">{pwState.error}</Notice> : pwState?.ok ? <Notice>{pwState.ok}</Notice> : null}
              <Button variant="secondary" disabled={pwPending}>Reset their password</Button>
            </form>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

type KeyInfo = { provider: string; last4: string; updated_at: string };

/** One provider's row in "AI providers": add a key, or replace or remove the saved one. */
export function ProviderKeyRow({
  provider,
  name,
  keyUrl,
  hint,
  saved,
  models = [],
}: {
  provider: string;
  name: string;
  keyUrl: string;
  hint: string;
  saved?: KeyInfo;
  models?: string[];
}) {
  const [editing, setEditing] = useState(!saved);
  const [state, action, pending] = useActionState(saveProviderKey.bind(null, provider), undefined);
  useEffect(() => {
    if (state?.ok) setEditing(false);
  }, [state]);
  const showForm = editing || !saved;
  return (
    <li className="flex flex-col gap-3 px-4 py-4" data-testid={`provider-${provider}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-[17px]">{name}</span>
          <span className="block text-[13px] text-mute">
            {saved ? (
              <>
                Added · ends in <span className="font-mono">{saved.last4}</span>
              </>
            ) : (
              "Not added"
            )}
          </span>
          {saved && models.length ? (
            <span className="mt-0.5 block text-[13px] text-mute" data-testid="key-models">
              Can use {models.join(", ")}
            </span>
          ) : null}
        </span>
        {saved && !editing ? (
          <span className="flex shrink-0 gap-4 text-[15px]">
            <button type="button" className="text-mute underline underline-offset-4" onClick={() => setEditing(true)}>
              Replace
            </button>
            <form action={removeProviderKey.bind(null, provider)}>
              <button className="text-mute underline underline-offset-4">Remove</button>
            </form>
          </span>
        ) : null}
      </div>
      {showForm ? (
        <form action={action} className="flex flex-col gap-2">
          <Field
            label={`${name} API key`}
            name="key"
            type="password"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            required
            hint={hint}
          />
          {state?.error ? <Notice tone="error">{state.error}</Notice> : null}
          <div className="flex gap-3">
            <Button variant="secondary" disabled={pending}>
              {pending ? "Checking…" : "Save key"}
            </Button>
            {saved ? (
              <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
          <a href={keyUrl} target="_blank" rel="noreferrer" className="px-1 text-[13px] text-mute underline underline-offset-4">
            Get a key from {name.split(" (")[0]}
          </a>
        </form>
      ) : state?.ok ? (
        <Notice>{state.ok}</Notice>
      ) : null}
    </li>
  );
}
