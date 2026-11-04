import Link from "next/link";
import { Wordmark } from "@/components/Wordmark";
import { NavLink } from "@/components/Press";

/** Three links fit beside the wordmark on a phone with slightly narrower pills. */
const PILL = "max-sm:px-2.5!";

/** Top bar for signed-in pages. The wordmark stays clean here; the glitch is for the title card. */
export function AppHeader({ isAdmin }: { isAdmin: boolean }) {
  return (
    <header
      className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-bg/90 px-4 py-3 backdrop-blur sm:px-5"
      style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
    >
      <Link href="/" className="press text-[20px]" aria-label="Depeche home">
        <Wordmark />
      </Link>
      <nav className="flex min-w-0 items-center gap-1 text-[14px] sm:gap-2 sm:text-[15px]">
        {isAdmin ? <NavLink href="/family" className={PILL}>Family</NavLink> : null}
        {isAdmin ? <NavLink href="/health" className={PILL}>Health</NavLink> : null}
        <NavLink href="/memory" className={PILL}>Memory</NavLink>
        <NavLink href="/account" className={PILL}>Account</NavLink>
      </nav>
    </header>
  );
}

export function Page({ children }: { children: React.ReactNode }) {
  return (
    <main
      className="mx-auto flex w-full max-w-[640px] flex-col gap-10 px-5 py-8"
      style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom))" }}
    >
      {children}
    </main>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-mute">{title}</h2>
      {children}
    </section>
  );
}
