/**
 * Demo sessions, as the proxy and the server see them. A demo key signs someone into the app
 * owner's account in one sign-in session, recorded in the owner's Supabase app_metadata.demo
 * (which only the server can change). Imports nothing server-only, so the proxy can use it.
 */

/** How long a demo session lasts before it is signed out. */
export const DEMO_SECONDS = 12 * 60 * 60;

/** Pages a demo session can't open: the family's API keys and members, the account, Health. */
export const DEMO_BLOCKED = ["/account", "/family", "/health", "/new-password", "/setup"];

export type DemoEntry = { s: string; e: number };

export function demoEntries(appMetadata: Record<string, unknown> | undefined): DemoEntry[] {
  const raw = appMetadata?.demo;
  if (!Array.isArray(raw)) return [];
  return raw.filter((d): d is DemoEntry => Boolean(d) && typeof d.s === "string" && typeof d.e === "number");
}

/** "none" for an ordinary session; "active" or "ended" for a demo one. */
export function demoState(
  appMetadata: Record<string, unknown> | undefined,
  sessionId: string | null | undefined,
  now = Math.floor(Date.now() / 1000),
): "none" | "active" | "ended" {
  if (!sessionId) return "none";
  const entry = demoEntries(appMetadata).find((d) => d.s === sessionId);
  if (!entry) return "none";
  return entry.e > now ? "active" : "ended";
}

export const isDemoBlocked = (path: string) => DEMO_BLOCKED.some((p) => path === p || path.startsWith(p + "/"));

/** Readable by the page: this tab is in a demo, so it signs out when opened in a fresh tab. */
export const DEMO_COOKIE = "dp_demo";
/** Set in sessionStorage by the tab that typed the demo key; gone when that tab closes. */
export const DEMO_TAB_KEY = "dp_demo_tab";
/** The random id this browser keeps for demo keys (localStorage). */
export const DEMO_DEVICE_KEY = "dp_demo_device";
