-- Bug reports.
--
-- Anyone signed in can report a bug, a few times a day. A daily GitHub Action reads new reports,
-- has a model sort real bugs from the rest, and tries to fix the real ones in a pull request.
--
-- Report text is written by people, so the pipeline treats it as untrusted data. Who sent a report
-- is decided here from the signed-in account the server passes in (`from_owner`), never from what
-- the report says. Only reports from the app owner's own account may lead to a fix that merges
-- itself without the owner looking at it; see .github/workflows/bug-fixer.yml.
--
-- The browser can read its own reports (to show their status) and nothing else. Reports are
-- written only by the server, which enforces the daily limit, and updated only by the pipeline.

create table public.bug_reports (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  body        text not null check (char_length(body) between 10 and 2000),
  page        text check (page is null or char_length(page) <= 200),
  user_agent  text check (user_agent is null or char_length(user_agent) <= 400),
  -- Set from the reporter's profile when the report is saved, never from the report text.
  from_owner  boolean not null default false,
  status      text not null default 'new' check (status in (
                'new',          -- waiting for the daily run
                'triaging',     -- being read by the triage model
                'queued',       -- a real bug, waiting for the fixer
                'fixing',       -- the fixer is working on it
                'fixed',        -- the fix is merged
                'pr_open',      -- a fix is waiting for Hasan to look at it
                'needs_owner',  -- left for Hasan (sensitive area, unclear, or the fixer couldn't)
                'not_a_bug',    -- working as intended, or not something code can change
                'duplicate',    -- already reported
                'declined'      -- a fix was proposed and Hasan closed it
              )),
  summary     text check (summary is null or char_length(summary) <= 500),   -- the triage model's own words
  area        text check (area is null or char_length(area) <= 40),           -- which part of the app, per triage
  suspicious  boolean not null default false,                                 -- triage saw an attempt to steer the fixer
  note        text check (note is null or char_length(note) <= 1000),        -- what the pipeline did, for Hasan
  pr_url      text check (pr_url is null or pr_url ~ '^https://github\.com/'),
  attempts    integer not null default 0,
  claimed_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index bug_reports_owner_idx on public.bug_reports (owner_id, created_at desc);
create index bug_reports_status_idx on public.bug_reports (status, created_at);

revoke all on public.bug_reports from anon, authenticated;
grant select (id, owner_id, body, page, status, created_at, updated_at) on public.bug_reports to authenticated;

alter table public.bug_reports enable row level security;

-- Your own reports only. Not your family admin, not the app owner.
create policy bug_reports_select on public.bug_reports for select to authenticated
  using (owner_id = auth.uid());

-- How many reports one person can send in any 24 hours.
create function public.bug_report_daily_limit() returns integer
  language sql immutable set search_path = ''
  as $$ select 3 $$;

-- Saves a report for the signed-in person. The server passes the id it got from the session.
create function public.submit_bug_report(p_actor uuid, p_body text, p_page text, p_user_agent text)
  returns uuid
  language plpgsql security definer set search_path = ''
  as $$
  declare
    is_owner boolean;
    recent integer;
    rid uuid;
  begin
    select is_app_owner into is_owner from public.profiles where id = p_actor;
    if is_owner is null then
      raise exception 'No profile' using errcode = 'P0001';
    end if;
    -- Two reports sent at the same moment cannot both slip under the limit.
    perform pg_advisory_xact_lock(hashtext('depeche.bug_report:' || p_actor::text));
    select count(*) into recent from public.bug_reports
      where owner_id = p_actor and created_at > now() - interval '24 hours';
    if recent >= public.bug_report_daily_limit() then
      raise exception 'You can send % bug reports a day. Try again tomorrow', public.bug_report_daily_limit()
        using errcode = 'P0001';
    end if;
    insert into public.bug_reports (owner_id, body, page, user_agent, from_owner)
      values (p_actor, trim(p_body), nullif(trim(p_page), ''), nullif(left(trim(p_user_agent), 400), ''), is_owner)
      returning id into rid;
    return rid;
  end
  $$;

-- ---------------------------------------------------------------------------
-- The daily pipeline. Run by the GitHub Action with the database connection, never the browser.
-- ---------------------------------------------------------------------------

-- Claims new reports for triage. Reports stuck in triage for six hours (a crashed run) are retried.
create function public.bug_reports_claim_for_triage(p_limit integer)
  returns table (id uuid, body text, page text, user_agent text, from_owner boolean, created_at timestamptz)
  language plpgsql security definer set search_path = ''
  as $$
  begin
    return query
      update public.bug_reports r
        set status = 'triaging', claimed_at = now(), updated_at = now()
        where r.id in (
          select b.id from public.bug_reports b
          where b.status = 'new' or (b.status = 'triaging' and b.claimed_at < now() - interval '6 hours')
          order by b.created_at
          limit p_limit
          for update skip locked
        )
      returning r.id, r.body, r.page, r.user_agent, r.from_owner, r.created_at;
  end
  $$;

-- Records the triage result. 'fix' queues the report for the fixer; anything else is final.
create function public.bug_report_triaged(
  p_id uuid, p_verdict text, p_summary text, p_note text, p_area text, p_suspicious boolean
)
  returns void
  language plpgsql security definer set search_path = ''
  as $$
  begin
    if p_verdict not in ('fix', 'not_a_bug', 'duplicate', 'needs_owner') then
      raise exception 'Unknown verdict %', p_verdict using errcode = 'P0001';
    end if;
    update public.bug_reports
      set status = case p_verdict when 'fix' then 'queued' else p_verdict end,
          summary = left(p_summary, 500), note = left(p_note, 1000), area = left(p_area, 40),
          suspicious = coalesce(p_suspicious, false), updated_at = now()
      where id = p_id and status = 'triaging';
  end
  $$;

-- Claims queued reports for the fixer, Hasan's first, then oldest first. A report whose fix run
-- died is retried once; after two attempts it is left for Hasan.
create function public.bug_reports_claim_for_fix(p_limit integer)
  returns table (
    id uuid, body text, summary text, area text, suspicious boolean, page text, user_agent text, from_owner boolean
  )
  language plpgsql security definer set search_path = ''
  as $$
  begin
    update public.bug_reports
      set status = 'needs_owner', note = 'The fixer stopped twice without finishing.', updated_at = now()
      where status = 'fixing' and claimed_at < now() - interval '20 hours' and attempts >= 2;
    return query
      update public.bug_reports r
        set status = 'fixing', attempts = r.attempts + 1, claimed_at = now(), updated_at = now()
        where r.id in (
          select b.id from public.bug_reports b
          where b.status = 'queued'
             or (b.status = 'fixing' and b.claimed_at < now() - interval '20 hours' and b.attempts < 2)
          order by b.from_owner desc, b.created_at
          limit p_limit
          for update skip locked
        )
      returning r.id, r.body, r.summary, r.area, r.suspicious, r.page, r.user_agent, r.from_owner;
  end
  $$;

-- Records what happened to a report the fixer worked on, or a pull request Hasan later closed.
create function public.bug_report_finished(p_id uuid, p_status text, p_note text, p_pr_url text)
  returns void
  language plpgsql security definer set search_path = ''
  as $$
  begin
    if p_status not in ('fixed', 'pr_open', 'needs_owner', 'declined') then
      raise exception 'Unknown status %', p_status using errcode = 'P0001';
    end if;
    update public.bug_reports
      set status = p_status, note = coalesce(left(p_note, 1000), note),
          pr_url = coalesce(nullif(p_pr_url, ''), pr_url), updated_at = now()
      where id = p_id;
  end
  $$;

revoke all on function
  public.bug_report_daily_limit(), public.submit_bug_report(uuid, text, text, text),
  public.bug_reports_claim_for_triage(integer), public.bug_report_triaged(uuid, text, text, text, text, boolean),
  public.bug_reports_claim_for_fix(integer), public.bug_report_finished(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function
  public.bug_report_daily_limit(), public.submit_bug_report(uuid, text, text, text),
  public.bug_reports_claim_for_triage(integer), public.bug_report_triaged(uuid, text, text, text, text, boolean),
  public.bug_reports_claim_for_fix(integer), public.bug_report_finished(uuid, text, text, text)
  to service_role;
