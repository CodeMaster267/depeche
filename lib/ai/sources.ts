import type { Source } from "@/lib/chat/thread";

/** Only web links are kept as sources, so a "javascript:" or "data:" URL can never become a link. */
export function webSource(url: unknown, title: unknown, domain?: unknown): Source | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const t = typeof title === "string" && title.trim() ? title.trim().slice(0, 300) : u.hostname;
    const d = typeof domain === "string" && domain.trim() ? domain.trim().slice(0, 120) : undefined;
    return { url: u.toString(), title: t, ...(d ? { domain: d } : {}) };
  } catch {
    return null;
  }
}
