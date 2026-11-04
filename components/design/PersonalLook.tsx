import type { ReactNode } from "react";
import { getMe } from "@/lib/auth/session";
import { loadLook } from "@/lib/design/load";
import { LookProvider } from "./Look";

/**
 * Wraps a signed-in page in the person's own look. Sign-in, setup and invite pages never use it,
 * so they always look like standard Depeche (part of the protected core).
 */
export async function PersonalLook({ children }: { children: ReactNode }) {
  const me = await getMe();
  if (!me) return <>{children}</>;
  const look = await loadLook(me).catch(() => null);
  if (!look) return <>{children}</>;
  return (
    <LookProvider current={look.current} offered={look.offered} safe={look.safe} enabled={look.enabled}>
      {children}
    </LookProvider>
  );
}
