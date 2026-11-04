/** "Deleted tomorrow", "Deleted in 2 days": when the daily clean-up will take a chat. */
export function whenDeleted(deletesAt: string, now = Date.now()) {
  const days = Math.ceil((new Date(deletesAt).getTime() - now) / 86_400_000);
  return days <= 0 ? "Deleted at the next clean-up" : days === 1 ? "Deleted tomorrow" : `Deleted in ${days} days`;
}
