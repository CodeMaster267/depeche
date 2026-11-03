-- Bug reports are now handled by a daily scheduled task in the Claude project rather than by an
-- AI step in GitHub Actions. A plain Action (no AI, no API key) mirrors each new report to a GitHub
-- issue, and copies what happens on that issue back here so the reporter sees it.

alter table public.bug_reports
  add column issue_url text check (issue_url is null or issue_url ~ '^https://github\.com/');

-- Reports already mirrored to an issue are never claimed again.
create or replace function public.bug_reports_claim_for_triage(p_limit integer)
  returns table (id uuid, body text, page text, user_agent text, from_owner boolean, created_at timestamptz)
  language plpgsql security definer set search_path = ''
  as $$
  begin
    return query
      update public.bug_reports r
        set status = 'triaging', claimed_at = now(), updated_at = now()
        where r.id in (
          select b.id from public.bug_reports b
          where b.issue_url is null
            and (b.status = 'new' or (b.status = 'triaging' and b.claimed_at < now() - interval '6 hours'))
          order by b.created_at
          limit p_limit
          for update skip locked
        )
      returning r.id, r.body, r.page, r.user_agent, r.from_owner, r.created_at;
  end
  $$;

create function public.bug_report_mirrored(p_id uuid, p_issue_url text) returns void
  language sql security definer set search_path = ''
  as $$ update public.bug_reports set issue_url = p_issue_url, updated_at = now() where id = p_id $$;

-- Copies an issue's state back. Any status but 'new' may be set; unchanged rows are left alone.
create function public.bug_report_set_status(p_id uuid, p_status text) returns void
  language plpgsql security definer set search_path = ''
  as $$
  begin
    if p_status = 'new' then
      raise exception 'A report cannot go back to new' using errcode = 'P0001';
    end if;
    update public.bug_reports set status = p_status, updated_at = now()
      where id = p_id and status is distinct from p_status;
  end
  $$;

revoke all on function public.bug_report_mirrored(uuid, text), public.bug_report_set_status(uuid, text)
  from public, anon, authenticated;
grant execute on function public.bug_report_mirrored(uuid, text), public.bug_report_set_status(uuid, text)
  to service_role;
