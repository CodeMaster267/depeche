import type { Metadata } from "next";
import { Wordmark } from "@/components/Wordmark";
import { Notice, TitleCardPage } from "@/components/ui";
import { isConfigured } from "@/lib/config";
import { getMe } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { hashToken } from "@/lib/tokens";
import { AcceptInvite } from "./AcceptInvite";

export const metadata: Metadata = { title: "You're invited · Depeche" };

type Preview = { family_name: string; email: string; display_name: string; role: string; state: string };

export default async function Invite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let invite: Preview | undefined;
  if (isConfigured()) {
    const { data } = await supabaseAdmin().rpc("invite_preview", { p_token_hash: hashToken(token) });
    invite = (data as Preview[] | null)?.[0];
  }
  const me = invite ? await getMe() : null;

  const problem = !invite
    ? "This invite link isn't valid. Ask whoever invited you to send a new one."
    : invite.state === "used"
      ? "This invite has already been used. If it was you, just sign in."
      : invite.state === "expired"
        ? "This invite has expired. Ask whoever invited you to send a new one."
        : me
          ? "You're already signed in to Depeche. Sign out first to accept a different invite."
          : null;

  return (
    <TitleCardPage>
      <h1 className="text-[48px]">
        <Wordmark glitch />
      </h1>
      {problem || !invite ? (
        <>
          <Notice tone="error">{problem}</Notice>
          <a href="/sign-in" className="text-center text-[15px] text-mute underline underline-offset-4">
            Go to sign in
          </a>
        </>
      ) : (
        <>
          <p className="text-[17px] text-mute">
            {invite.display_name}, you&apos;re invited to join <strong className="text-fg">{invite.family_name}</strong>
            {invite.role === "admin" ? " as its admin" : ""}.
          </p>
          <p className="mb-4 text-[15px] text-faint">Invite for {invite.email}</p>
          <AcceptInvite token={token} />
        </>
      )}
    </TitleCardPage>
  );
}
