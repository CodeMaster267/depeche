import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { isUnlocked, lockSession } from "@/lib/lock/server";
import { LockPage } from "./LockPage";

export const metadata: Metadata = { title: "Locked · Depeche" };

/** Only a path inside Depeche, never another site. */
function safeNext(next: string | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

/** Where a locked device lands when it opens Depeche. */
export default async function Lock({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  const s = await lockSession();
  if (!s) redirect("/sign-in");
  if (!s.meta || (await isUnlocked(s))) redirect(next);
  return <LockPage pinLength={s.meta.n} passkeys={s.meta.pk > 0} next={next} />;
}
