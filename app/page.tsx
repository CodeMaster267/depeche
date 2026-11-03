import { Wordmark } from "@/components/Wordmark";

/**
 * Placeholder title card. Sign-in arrives in step 3; until then this confirms the
 * deployment works and the type and glitch render on real devices.
 */
export default function Home() {
  return (
    <main
      className="flex min-h-full flex-col justify-center gap-4 px-7"
      style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <h1 className="text-[48px]">
        <Wordmark glitch />
      </h1>
      <p className="text-[15px] text-mute">Invite only. Sign-in is coming in the next step.</p>
    </main>
  );
}
