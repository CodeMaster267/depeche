import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChatApp } from "@/components/chat/ChatApp";
import { requireMe } from "@/lib/auth/session";
import { loadProject, loadShell } from "@/lib/chat/load";

export const metadata: Metadata = { title: "Depeche" };
export const dynamic = "force-dynamic";

/** A project's screen: its instructions, files and chats, and a box that starts a chat inside it. */
export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ new?: string }> }) {
  const [{ id }, { new: fresh }] = await Promise.all([params, searchParams]);
  const me = await requireMe();
  const [shell, project] = await Promise.all([loadShell(me), loadProject(me, id)]);
  if (!project) notFound();
  // "New chat" from a chat begun on this screen adds ?new=… so the screen starts over.
  return <ChatApp key={`p-${id}-${String(fresh ?? "").slice(0, 20)}`} shell={shell} chat={null} messages={[]} project={project} />;
}
