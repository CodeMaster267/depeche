import type { Metadata } from "next";
import Link from "next/link";
import { AppHeader, Page, Section } from "@/components/AppHeader";
import { Button } from "@/components/ui";
import { requireMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { describeLog, when, type LogRow } from "@/lib/family/log";
import { signOut } from "@/app/sign-in/actions";
import { signOutEverywhere } from "./actions";
import { ExportButton } from "@/components/ExportButton";
import { vapidKeys } from "@/lib/push/server";
import { NotificationsToggle } from "./Notifications";
import { DeleteEverythingForm, KeepChatsToggle, PasswordForm, ProfileForm, ShareTitlesToggle } from "./forms";

export const metadata: Metadata = { title: "Account · Depeche" };

export default async function Account() {
  const me = await requireMe();
  const db = await supabaseServer();
  // Row-level security shows each person only the admin log entries about themselves (admins
  // see their whole family's on the Family page).
  const [{ data: log }, { data: people }] = await Promise.all([
    db
      .from("admin_log")
      .select("id, actor_id, subject_id, action, detail, created_at")
      .eq("subject_id", me.userId)
      .order("created_at", { ascending: false })
      .limit(20)
      .returns<LogRow[]>(),
    db.from("profiles").select("id, display_name").returns<{ id: string; display_name: string }[]>(),
  ]);
  const { data: prefs } = await db.from("profiles").select("keep_chats").eq("id", me.userId).maybeSingle<{ keep_chats: boolean }>();
  const names = new Map((people ?? []).map((p) => [p.id, p.display_name]));

  return (
    <>
      <AppHeader isAdmin={me.profile.role === "admin"} />
      <Page>
        <div className="flex items-start justify-between gap-4 pt-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-[34px] font-semibold tracking-tight">Account</h1>
            <p className="truncate text-[15px] text-mute">{me.email}</p>
          </div>
          <form action={signOut} className="shrink-0 pt-2">
            <Button variant="secondary" className="h-11! w-auto! rounded-xl! px-4! text-[15px]!">
              Sign out
            </Button>
          </form>
        </div>
        <Section title="You">
          <ProfileForm name={me.profile.display_name} username={me.profile.username ?? ""} />
        </Section>
        <Section title="Password">
          <p className="text-[15px] text-mute">
            Set one to sign in with your username or email and a password. Forgot it? Your family admin can give you a
            temporary one.
          </p>
          <PasswordForm />
        </Section>
        <Section title="Notifications">
          <NotificationsToggle publicKey={vapidKeys()?.publicKey ?? null} />
        </Section>
        <Section title="Old chats">
          <KeepChatsToggle keep={prefs?.keep_chats ?? false} />
        </Section>
        <Section title="Privacy">
          <p className="text-[15px] text-mute">
            Only you can read your chats. Your family admin sees how much you spend. Each message goes to the AI company
            whose model you pick, and to no one else.
          </p>
          <ShareTitlesToggle shared={me.profile.share_titles} isAdmin={me.profile.role === "admin"} />
        </Section>
        <Section title="Devices">
          <p className="text-[15px] text-mute">Lost a phone, or signed in somewhere you shouldn&apos;t have? This signs you out on every device, this one too.</p>
          <form action={signOutEverywhere}>
            <Button variant="secondary">Sign out everywhere</Button>
          </form>
        </Section>
        {(log ?? []).length ? (
          <Section title="Changes made to your account">
            <ul className="flex flex-col gap-2 text-[15px]" data-testid="my-log">
              {(log ?? []).map((l) => (
                <li key={l.id} className="flex flex-col">
                  <span>{describeLog(l, names, me.userId)}</span>
                  <span className="text-[13px] text-mute">{when(l.created_at)}</span>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        <Section title="Your data">
          <p className="text-[15px] text-mute">
            Download a zip of all your chats, memories, the files Depeche still has, your spending and your settings.
            Chats come as Markdown you can read anywhere, plus JSON with every detail. Only your own data is in it.
          </p>
          <ExportButton userId={me.userId} email={me.email} />
        </Section>
        <Section title="Delete">
          <p className="text-[15px] text-mute">
            Permanently delete all your chats and memories. They&apos;re gone straight away, and out of Depeche&apos;s
            backups within 30 days. Your spending history stays, without any chat in it.
          </p>
          <DeleteEverythingForm />
        </Section>
        <Section title="Something broken?">
          <Link href="/report?from=/account" className="press text-[15px] underline underline-offset-4">
            Report a bug
          </Link>
        </Section>
      </Page>
    </>
  );
}
