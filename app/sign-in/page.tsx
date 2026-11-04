import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Wordmark } from "@/components/Wordmark";
import { TitleCardPage, Notice } from "@/components/ui";
import { isConfigured, missingSettings } from "@/lib/config";
import { getMe } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { SignInForms } from "./SignInForms";
import { RippleField } from "@/components/RippleField";

export const metadata: Metadata = { title: "Sign in · Depeche" };

const ERRORS: Record<string, string> = {
  "not-invited": "That account isn't part of Depeche. Ask your family admin for an invite.",
  link: "That sign-in link has expired or was already used. Send a new one.",
  google: "Google sign-in isn't available right now. Try another way.",
  "not-ready": "Depeche isn't connected to its database yet.",
};

export default async function SignIn({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (isConfigured()) {
    if (await getMe()) redirect("/");
    // Before anyone owns Depeche, the only thing to do is set it up.
    const { data: hasOwner } = await supabaseAdmin().rpc("app_owner_exists");
    if (hasOwner === false) redirect("/setup");
  }
  const { error } = await searchParams;

  return (
    <>
      {/* The letterflip field fills the screen and keeps clear of the sign-in column. */}
      <RippleField className="fixed inset-0" clear="[data-ripple-clear]" />
      <TitleCardPage>
        <div data-ripple-clear className="relative flex flex-col gap-4">
          <h1 className="text-[48px]">
            <Wordmark glitch />
          </h1>
          <p className="mb-6 text-[17px] text-mute">Invite only. Sign in to continue.</p>
          {!isConfigured() ? (
            <Notice tone="error">
              Depeche isn&apos;t fully set up yet. Missing in Vercel: {missingSettings().join(", ")}. Add them, then redeploy.
            </Notice>
          ) : error && ERRORS[error] ? (
            <Notice tone="error">{ERRORS[error]}</Notice>
          ) : null}
          <SignInForms />
          <p className="mt-10 text-center text-[13px] text-faint">No account yet? Ask your family admin for an invite.</p>
          <p className="mt-2 text-center text-[13px] text-faint" data-testid="who-sees">
            Only you can read your chats. Each message goes only to the AI company whose model you pick.
          </p>
        </div>
      </TitleCardPage>
    </>
  );
}
