import type { Metadata } from "next";
import Link from "next/link";
import { AppHeader, Page, Section } from "@/components/AppHeader";
import { Button } from "@/components/ui";
import { requireMe } from "@/lib/auth/session";
import { signOut } from "@/app/sign-in/actions";
import { supabaseServer } from "@/lib/supabase/server";
import { KeepChatsToggle, PasswordForm, ProfileForm } from "./forms";

export const metadata: Metadata = { title: "Account · Depeche" };

export default async function Account() {
  const me = await requireMe();
  const { data: prefs } = await (await supabaseServer())
    .from("profiles")
    .select("keep_chats")
    .eq("id", me.userId)
    .maybeSingle<{ keep_chats: boolean }>();
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
            Set one to sign in with your username or email and a password. Forgot it? Your family admin can reset it.
          </p>
          <PasswordForm />
        </Section>
        <Section title="Old chats">
          <KeepChatsToggle keep={prefs?.keep_chats ?? false} />
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
