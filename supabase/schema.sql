-- Run in Supabase SQL Editor. Funnel rows are scoped to the authenticated user.
create table if not exists public.private_funnel_records (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  campaign_id text not null,
  campaign_name text not null,
  period_since date not null,
  period_until date not null,
  qualified_leads integer,
  meetings_scheduled integer,
  meetings_attended integer,
  deals_closed integer,
  outcome_note text not null default '',
  constraint private_funnel_period_valid check (period_since <= period_until),
  constraint private_funnel_counts_nonnegative check (
    (qualified_leads is null or qualified_leads >= 0) and
    (meetings_scheduled is null or meetings_scheduled >= 0) and
    (meetings_attended is null or meetings_attended >= 0) and
    (deals_closed is null or deals_closed >= 0)
  ),
  constraint private_funnel_meetings_valid check (
    meetings_attended is null or meetings_scheduled is null or meetings_attended <= meetings_scheduled
  ),
  constraint private_funnel_deals_valid check (
    deals_closed is null or qualified_leads is null or deals_closed <= qualified_leads
  ),
  constraint private_funnel_unique_entry unique (user_id, campaign_id, period_since, period_until)
);

alter table public.private_funnel_records enable row level security;

revoke all on public.private_funnel_records from anon, authenticated;
grant select on public.private_funnel_records to authenticated;

drop policy if exists "Users read only their own funnel" on public.private_funnel_records;
create policy "Users read only their own funnel"
  on public.private_funnel_records for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users insert only their own funnel" on public.private_funnel_records;
create policy "Users insert only their own funnel"
  on public.private_funnel_records for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users delete only their own funnel" on public.private_funnel_records;
create policy "Users delete only their own funnel"
  on public.private_funnel_records for delete to authenticated
  using ((select auth.uid()) = user_id);

grant usage, select on sequence public.private_funnel_records_id_seq to authenticated;

create or replace function public.replace_my_funnel(entries jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  delete from public.private_funnel_records where user_id = current_user_id;

  insert into public.private_funnel_records (
    user_id, campaign_id, campaign_name, period_since, period_until,
    qualified_leads, meetings_scheduled, meetings_attended, deals_closed, outcome_note
  )
  select
    current_user_id, row_data.campaign_id, row_data.campaign_name,
    row_data.period_since, row_data.period_until, row_data.qualified_leads,
    row_data.meetings_scheduled, row_data.meetings_attended, row_data.deals_closed,
    coalesce(row_data.outcome_note, '')
  from jsonb_to_recordset(coalesce(entries, '[]'::jsonb)) as row_data(
    campaign_id text,
    campaign_name text,
    period_since date,
    period_until date,
    qualified_leads integer,
    meetings_scheduled integer,
    meetings_attended integer,
    deals_closed integer,
    outcome_note text
  );
end;
$$;

revoke all on function public.replace_my_funnel(jsonb) from public, anon;
grant execute on function public.replace_my_funnel(jsonb) to authenticated;
