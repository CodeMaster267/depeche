import type { Metadata } from "next";
import { AppHeader, Page, Section } from "@/components/AppHeader";
import { Button } from "@/components/ui";
import { requireMe } from "@/lib/auth/session";
import { signOut } from "@/app/sign-in/actions";
import { PasswordForm, ProfileForm } from "./forms";

export const metadata: Metadata = { title: "Account · Depeche" };

export default async function Account() {
  const me = await requireMe();
  return (
    <>
      <AppHeader isAdmin={me.profile.role === "admin"} />
      <Page>
        <div className="flex flex-col gap-1 pt-4">
          <h1 className="text-[34px] font-semibold tracking-tight">Account</h1>
          <p className="text-[15px] text-mute">{me.email}</p>
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
        <form action={signOut}>
          <Button variant="secondary">Sign out</Button>
        </form>
      </Page>
    </>
  );
}
