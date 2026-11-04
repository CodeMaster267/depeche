import Link from "next/link";
import { Wordmark } from "@/components/Wordmark";
import { NavLink } from "@/components/Press";
import { PagesMenu } from "@/components/PagesMenu";
import { PersonalLook } from "@/components/design/PersonalLook";
import { Shortcuts } from "@/components/design/Look";


/** Top bar for signed-in pages. The wordmark stays clean here; the glitch is for the title card. */
export function AppHeader({ isAdmin }: { isAdmin: boolean }) {
  const pages = [
    ...(isAdmin ? [{ href: "/family", label: "Family" }, { href: "/health", label: "Health" }] : []),
    { href: "/memory", label: "Memory" },
    { href: "/account", label: "Account" },
  ];
  return (
    <PersonalLook>
    <header
      data-part="page-header"
      className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-line bg-bg/90 px-4 py-3 backdrop-blur sm:px-5"
      style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
    >
      <Link href="/" className="press text-[20px]" aria-label="Depeche home">
        <Wordmark />
      </Link>
      <nav className="flex min-w-0 items-center gap-1 text-[14px] sm:gap-2 sm:text-[15px]">
        <Shortcuts place="header" isAdmin={isAdmin} className="max-sm:hidden" />
        {/* A wrapper hides the pills on phones: .nav-pill's own display would beat a class on the link. */}
        <span className="hidden items-center gap-2 sm:flex">
          {pages.map((p) => (
            <NavLink key={p.href} href={p.href}>
              {p.label}
            </NavLink>
          ))}
        </span>
        <PagesMenu pages={pages} />
      </nav>
    </header>
    </PersonalLook>
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
    <section id={slug(title)} className="flex scroll-mt-20 flex-col gap-4">
      <h2 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-mute">{title}</h2>
      {children}
    </section>
  );
}

/** "Your data" → "your-data", so a setting can be linked to (and become a button of its own). */
export function slug(title: string): string {
  return title.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
