import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppHeader, Page } from "@/components/AppHeader";
import { requireMe } from "@/lib/auth/session";
import { loadAssistant, loadShell } from "@/lib/chat/load";
import { AssistantEditor } from "./editor";

export const metadata: Metadata = { title: "Assistant · Depeche" };
export const dynamic = "force-dynamic";

/** Make or change one of your assistants, or look at one your family shared. */
export default async function AssistantPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await requireMe();
  const [shell, assistant] = await Promise.all([loadShell(me), id === "new" ? Promise.resolve(null) : loadAssistant(me, id)]);
  if (id !== "new" && !assistant) notFound();
  return (
    <>
      <AppHeader isAdmin={me.profile.role === "admin"} />
      <Page>
        <AssistantEditor key={id} userId={me.userId} assistant={assistant} modelIds={shell.modelIds} />
      </Page>
    </>
  );
}
