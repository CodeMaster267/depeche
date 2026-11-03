import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Wordmark } from "@/components/Wordmark";
import { TitleCardPage } from "@/components/ui";
import { requireMe } from "@/lib/auth/session";
import { PasswordForm } from "@/app/account/forms";

export const metadata: Metadata = { title: "Choose a password · Depeche" };

/** Where someone lands after signing in with a temporary password from their family admin. */
export default async function NewPassword() {
  const me = await requireMe({ allowTempPassword: true });
  if (!me.profile.must_change_password) redirect("/");
  return (
    <TitleCardPage>
      <h1 className="text-[48px]">
        <Wordmark />
      </h1>
      <p className="mb-6 text-[17px] text-mute">
        Hi, {me.profile.display_name}. You signed in with a temporary password. Choose your own to carry on.
      </p>
      <PasswordForm label="Save and continue" />
    </TitleCardPage>
  );
}
