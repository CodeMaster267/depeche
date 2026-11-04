import type { Metadata } from "next";
import { AppHeader } from "@/components/AppHeader";
import { requireMe } from "@/lib/auth/session";
import { HelpPage } from "./HelpPage";

export const metadata: Metadata = { title: "Concierge · Depeche" };

/** Concierge on a page of its own, so it can be linked to (depai.vercel.app/help). */
export default async function Help() {
  const me = await requireMe();
  return (
    <>
      <AppHeader isAdmin={me.profile.role === "admin"} />
      <HelpPage isAdmin={me.profile.role === "admin"} />
    </>
  );
}
