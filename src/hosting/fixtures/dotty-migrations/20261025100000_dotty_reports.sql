-- Reporting other people's moments (App Store requires a way to report content).
create table dotty.reports (
  id          uuid primary key default gen_random_uuid(),
  moment_id   uuid not null references dotty.moments (id) on delete cascade,
  reporter_id uuid not null default auth.uid() references dotty.profiles (id) on delete cascade,
  reason      text not null check (reason in ('spam', 'inappropriate', 'harassment', 'other')),
  created_at  timestamptz not null default now(),
  unique (moment_id, reporter_id)
);
create index reports_moment_idx on dotty.reports (moment_id);
alter table dotty.reports enable row level security;

-- you can report moments you can see (not your own); nobody can read reports via the API
create policy reports_insert on dotty.reports for insert to authenticated
  with check (
    reporter_id = (select auth.uid())
    and exists (select 1 from dotty.moments m where m.id = moment_id and m.user_id <> (select auth.uid()))
  );
revoke all on dotty.reports from anon, authenticated;
grant insert (moment_id, reason) on dotty.reports to authenticated;
