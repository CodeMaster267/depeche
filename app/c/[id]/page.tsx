import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChatApp } from "@/components/chat/ChatApp";
import { requireMe } from "@/lib/auth/session";
import { loadChat, loadShell } from "@/lib/chat/load";

export const metadata: Metadata = { title: "Depeche" };

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await requireMe();
  const [shell, found] = await Promise.all([loadShell(me), loadChat(me, id)]);
  if (!found) notFound();
  return <ChatApp key={id} shell={shell} chat={found.chat} messages={found.messages} summaries={found.summaries} />;
}
