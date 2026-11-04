import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChatApp } from "@/components/chat/ChatApp";
import { requireMe } from "@/lib/auth/session";
import { loadChat, loadShell } from "@/lib/chat/load";

export const metadata: Metadata = { title: "Depeche" };

export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ m?: string | string[] }>;
}) {
  const [{ id }, { m }] = await Promise.all([params, searchParams]);
  // ?m= is the message a search result points at.
  const focus = typeof m === "string" && /^[0-9a-f-]{36}$/i.test(m) ? m : null;
  const me = await requireMe();
  const [shell, found] = await Promise.all([loadShell(me), loadChat(me, id)]);
  if (!found) notFound();
  return <ChatApp key={`${id}:${focus ?? ""}`} shell={shell} chat={found.chat} messages={found.messages} focus={focus} />;
}
