import { Wordmark } from "@/components/Wordmark";
import { AppHeader, Page } from "@/components/AppHeader";
import { isConfigured } from "@/lib/config";
import { requireMe } from "@/lib/auth/session";

/** Home. Chats arrive in the next step; for now this confirms who is signed in. */
export default async function Home() {
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
  return (
    <>
      <AppHeader isAdmin={me.profile.role === "admin"} />
      <Page>
        <div className="flex flex-col gap-2 pt-10">
          <h1 className="text-[34px] font-semibold tracking-tight">Hi, {me.profile.display_name}.</h1>
          <p className="text-[17px] text-mute">You&apos;re signed in. Chats arrive in the next update.</p>
        </div>
      </Page>
    </>
  );
}
