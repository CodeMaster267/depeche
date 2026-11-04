/**
 * Comparing models side by side. One question goes to two or three models; each answer is an
 * ordinary reply to the same message (siblings, like "Try again"), tagged with the same group id
 * and its place in the row. The person swipes between them and picks one to continue from, and
 * the conversation carries on from that reply. Nothing is ever deleted or rewritten.
 *
 * Every answer is its own request on the server, which reserves and settles its own spending, so
 * all of them count toward the person's monthly limit.
 */
import type { MessageRow } from "./thread";

/** The most models one question can go to at once. */
export const MAX_COMPARE = 3;

/**
 * The answers in a reply's comparison, in the order the models were chosen. If one model was
 * asked again (after a failure), its newest answer is the one shown. A reply that isn't part of
 * a comparison gives an empty list.
 */
export function comparedWith<T extends MessageRow>(all: readonly T[], reply: T): T[] {
  const group = reply.content.compare?.id;
  if (!group || reply.role !== "assistant") return [];
  const bySlot = new Map<number, T>();
  for (const m of all) {
    if (m.role !== "assistant" || m.parent_id !== reply.parent_id || m.content.compare?.id !== group) continue;
    const slot = m.content.compare.slot;
    const seen = bySlot.get(slot);
    if (!seen || m.created_at > seen.created_at || (m.created_at === seen.created_at && m.id === reply.id)) bySlot.set(slot, m);
  }
  // The reply being shown always stays in its own slot, even if a newer one exists there.
  bySlot.set(reply.content.compare!.slot, reply);
  return [...bySlot.entries()].sort((a, b) => a[0] - b[0]).map(([, m]) => m);
}

/** Toggle a model in the compare selection: at most MAX_COMPARE, in the order they were picked. */
export function toggleCompare(selected: readonly string[], id: string): string[] {
  if (selected.includes(id)) return selected.filter((x) => x !== id);
  if (selected.length >= MAX_COMPARE) return [...selected];
  return [...selected, id];
}
