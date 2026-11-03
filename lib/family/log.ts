/** Turns admin log rows into sentences, for the family page and for each person's Account page. */
export type LogRow = {
  id: string;
  actor_id: string | null;
  subject_id: string | null;
  action: string;
  detail: Record<string, unknown>;
  created_at: string;
};

const PROVIDER_NAMES: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", google: "Google" };
const money = (v: unknown) => `$${Number(v ?? 0).toFixed(2)}`;

export function describeLog(row: LogRow, names: Map<string, string>, me: string): string {
  const name = (id: string | null) => (id ? (names.get(id) ?? "someone") : "someone");
  const actor = row.actor_id === me ? "You" : name(row.actor_id).replace(/^s/, "S");
  const whom = row.subject_id === me ? "you" : name(row.subject_id);
  const whose = row.subject_id === me ? "your" : `${name(row.subject_id)}'s`;
  const d = row.detail ?? {};
  const invitee = String(d.name ?? d.email ?? "someone");
  const provider = PROVIDER_NAMES[String(d.provider)] ?? "AI";
  switch (row.action) {
    case "invite_created":
      return `${actor} invited ${invitee}${d.role === "admin" ? " as admin" : ""}`;
    case "invite_cancelled":
      return `${actor} cancelled the invite for ${invitee}`;
    case "cap_changed":
      return `${actor} changed ${whose} monthly limit from ${money(d.from)} to ${money(d.to)}`;
    case "password_reset":
      return `${actor} gave ${whom} a temporary password`;
    case "signed_out":
      return row.actor_id === row.subject_id ? `${actor} signed out everywhere` : `${actor} signed ${whom} out on all devices`;
    case "admin_added":
      return `${actor} made ${whom} a backup admin`;
    case "admin_removed":
      return row.actor_id === row.subject_id ? `${actor} stepped down as admin` : `${actor} took away ${whose} admin role`;
    case "key_saved":
      return `${actor} saved the ${provider} key ending ${String(d.last4 ?? "")}`;
    case "key_removed":
      return `${actor} took out the ${provider} key`;
    default:
      return `${actor} changed a setting`;
  }
}

export function when(iso: string): string {
  return (
    new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) +
    " UTC"
  );
}
