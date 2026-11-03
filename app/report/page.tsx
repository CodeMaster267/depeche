import type { Metadata } from "next";
import { AppHeader, Page, Section } from "@/components/AppHeader";
import { requireMe } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { safeNext } from "@/lib/validate";
import { ReportForm } from "./form";

export const metadata: Metadata = { title: "Report a bug · Depeche" };

type Report = { id: string; body: string; status: string; created_at: string; updated_at: string };

/** What each step means to the person who sent the report. */
const STATUS: Record<string, string> = {
  new: "Sent",
  triaging: "Being looked at",
  queued: "Confirmed, fix coming",
  fixing: "Being fixed",
  fixed: "Fixed",
  pr_open: "Fix waiting for Hasan",
  needs_owner: "Passed to Hasan",
  not_a_bug: "Not a bug",
  duplicate: "Already reported",
  declined: "Not changed",
};

/**
 * Report a bug. A daily job reads new reports and fixes the real ones. People see only their own
 * reports here (row-level security), with where each one is.
 */
export default async function ReportBug({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const me = await requireMe();
  const { from } = await searchParams;
  const { data: reports } = await (await supabaseServer())
    .from("bug_reports")
    .select("id, body, status, created_at, updated_at")
    .eq("owner_id", me.userId)
    .order("created_at", { ascending: false })
    .limit(20)
    .returns<Report[]>();

  return (
    <>
      <AppHeader isAdmin={me.profile.role === "admin"} />
      <Page>
        <div className="flex flex-col gap-2 pt-4">
          <h1 className="text-[34px] font-semibold tracking-tight">Report a bug</h1>
          <p className="text-[15px] text-mute">
            Say what happened and what you expected. Claude reads new reports once a day and fixes real bugs, and
            Hasan checks anything it isn&apos;t sure about. You can send 3 a day.
          </p>
        </div>
        <ReportForm from={from ? safeNext(from) : "/"} />
        {reports?.length ? (
          <Section title="Your reports">
            <ul className="flex flex-col divide-y divide-line" data-testid="my-reports">
              {reports.map((r) => (
                <li key={r.id} className="flex flex-col gap-1.5 py-3">
                  <p className="line-clamp-3 whitespace-pre-line break-words text-[16px]">{r.body}</p>
                  <p className="flex justify-between gap-3 text-[13px] text-mute">
                    <span className="font-medium text-fg">{STATUS[r.status] ?? r.status}</span>
                    <time dateTime={r.created_at}>
                      {new Date(r.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                    </time>
                  </p>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
      </Page>
    </>
  );
}
