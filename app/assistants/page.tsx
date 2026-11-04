import type { Metadata } from "next";
import Link from "next/link";
import { AppHeader, Page, Section } from "@/components/AppHeader";
import { GlassCode } from "@/components/Glass";
import { requireMe } from "@/lib/auth/session";
import { loadShell } from "@/lib/chat/load";
import { findModel } from "@/lib/ai/models";
import type { AssistantRow } from "@/lib/chat/assistants";

export const metadata: Metadata = { title: "Assistants · Depeche" };
export const dynamic = "force-dynamic";

/** Saved assistants: yours, and the ones people in your family shared. */
export default async function Assistants() {
  const me = await requireMe();
  const shell = await loadShell(me);
  const mine = shell.assistants.filter((a) => a.mine);
  const family = shell.assistants.filter((a) => !a.mine);

  return (
    <>
      <AppHeader isAdmin={me.profile.role === "admin"} />
      <Page>
        <div className="flex flex-col gap-2 pt-4">
          <h1 className="text-[34px] font-semibold tracking-tight">Assistants</h1>
          <p className="text-[15px] text-mute">
            An assistant starts chats set up a certain way: its own instructions, files and model. Keep one for yourself, or share it so
            everyone in your family can use it, like a homework helper for the kids. Chats with an assistant stay private to whoever is
            chatting.
          </p>
        </div>
        <Link
          href="/assistants/new"
          className="press glass glass-pill inline-flex h-14 w-full items-center justify-center gap-3 rounded-2xl px-5 text-[17px] font-semibold"
        >
          <GlassCode seed="new assistant" />
          <span>New assistant</span>
        </Link>
        <Section title="Yours">
          {mine.length ? <List list={mine} /> : <p className="text-[15px] text-mute">You haven&apos;t made any yet.</p>}
        </Section>
        <Section title="Shared by your family">
          {family.length ? <List list={family} /> : <p className="text-[15px] text-mute">Nobody in your family has shared one yet.</p>}
        </Section>
      </Page>
    </>
  );
}

function List({ list }: { list: AssistantRow[] }) {
  return (
    <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line" data-testid="assistants">
      {list.map((a) => (
        <li key={a.id} className="flex items-center gap-3 px-4 py-3.5">
          <Link href={`/assistants/${a.id}`} className="min-w-0 flex-1">
            <span className="block truncate text-[16px] font-medium">{a.name}</span>
            <span className="block truncate text-[14px] text-mute">
              {[a.description, a.mine && a.shared ? "Shared with your family" : "", findModel(a.model)?.short ?? ""].filter(Boolean).join(" · ") || "No description"}
            </span>
          </Link>
          <Link
            href={`/?assistant=${a.id}`}
            className="press shrink-0 rounded-full border border-line px-4 py-2 text-[15px]"
            aria-label={`Chat with ${a.name}`}
          >
            Chat
          </Link>
        </li>
      ))}
    </ul>
  );
}
