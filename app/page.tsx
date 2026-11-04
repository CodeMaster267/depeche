import { Wordmark } from "@/components/Wordmark";
import { ChatApp } from "@/components/chat/ChatApp";
import { isConfigured } from "@/lib/config";
import { requireMe } from "@/lib/auth/session";
import { loadShell } from "@/lib/chat/load";
import { PersonalLook } from "@/components/design/PersonalLook";

export const dynamic = "force-dynamic";

/** Home is a new chat. */
export default async function Home({ searchParams }: { searchParams: Promise<{ new?: string; assistant?: string; temporary?: string }> }) {
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
  // "New chat" from a chat begun on this screen adds ?new=… so the screen starts over, and
  // /?temporary opens a temporary chat straight away.
  const { new: fresh, assistant: assistantId, temporary } = await searchParams;
  // ?assistant=… starts the chat with one of your saved assistants (or one your family shared).
  const assistant = shell.assistants.find((a) => a.id === assistantId) ?? null;
  return (
    <PersonalLook>
      <ChatApp
        key={`new-${String(fresh ?? "").slice(0, 20)}-${assistant?.id ?? ""}`}
        shell={shell}
        chat={null}
        messages={[]}
        assistant={assistant}
        temporary={temporary !== undefined}
      />
    </PersonalLook>
  );
}
