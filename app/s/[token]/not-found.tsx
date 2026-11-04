import { Wordmark } from "@/components/Wordmark";

export default function ShareNotFound() {
  return (
    <main
      className="flex min-h-dvh flex-col justify-center gap-4 px-7"
      style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <p className="text-[28px]">
        <Wordmark />
      </p>
      <h1 className="text-[22px] font-semibold">This link doesn&apos;t work</h1>
      <p className="max-w-[420px] text-[16px] text-mute">The person who shared this chat may have stopped sharing it, or deleted the chat.</p>
    </main>
  );
}
