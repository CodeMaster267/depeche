import { Wordmark } from "@/components/Wordmark";
import { ChatApp } from "@/components/chat/ChatApp";
import { isConfigured } from "@/lib/config";
import { requireMe } from "@/lib/auth/session";
import { loadShell } from "@/lib/chat/load";

export const dynamic = "force-dynamic";

/** Home is a new chat. */
export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!isConfigured()) {
    // Before Supabase is connected, show the title card so a fresh deployment visibly works.
    return (
      <main
        className="flex min-h-full flex-col justify-center gap-4 px-7"
        style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <h1 className="text-[48px]">
          <Wordmark glitch />
        </h1>
        <p className="text-[15px] text-mute">Invite only. Depeche isn&apos;t connected to its database yet.</p>
      </main>
    );
  }

  const me = await requireMe();
  const shell = await loadShell(me);
  // /?temporary opens a temporary chat straight away.
  const temporary = (await searchParams).temporary !== undefined;
  return <ChatApp key="new" shell={shell} chat={null} messages={[]} temporary={temporary} />;
}
