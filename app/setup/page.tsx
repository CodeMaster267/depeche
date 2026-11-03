import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Wordmark } from "@/components/Wordmark";
import { TitleCardPage, Notice } from "@/components/ui";
import { isConfigured } from "@/lib/config";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { SetupForm } from "./SetupForm";

export const metadata: Metadata = { title: "Set up · Depeche" };
export const dynamic = "force-dynamic";

/** Shown once, before Depeche has an owner. Afterwards it just sends people to sign in. */
export default async function Setup() {
  if (!isConfigured()) {
    return (
      <TitleCardPage>
        <Notice tone="error">Depeche isn't connected to its database yet.</Notice>
      </TitleCardPage>
    );
  }
  const { data: taken } = await supabaseAdmin().rpc("app_owner_exists");
  if (taken) redirect("/sign-in");

  return (
    <TitleCardPage>
      <h1 className="text-[48px]">
        <Wordmark glitch />
      </h1>
      <p className="mb-6 text-[17px] text-mute">Welcome. Set up Depeche and your family.</p>
      <SetupForm />
    </TitleCardPage>
  );
}
