-- Streaks (≥ 1 moment per day, Berlin time) and weekly points + leaderboards.
--   +10 per moment, +15 per place you share for the first time,
--   +2 per 🔥 or comment from someone else on your moments,
--   +5 per streak day (max +50) as a bonus.
-- Weeks start Monday 00:00 Berlin time.

create or replace function dotty.berlin_day(ts timestamptz)
returns date language sql immutable set search_path = ''
as $$ select (ts at time zone 'Europe/Berlin')::date $$;

create or replace function dotty.week_start()
returns timestamptz language sql stable set search_path = ''
as $$ select (date_trunc('week', now() at time zone 'Europe/Berlin')) at time zone 'Europe/Berlin' $$;

-- current streak in days, and whether today already counts
create or replace function dotty.user_streak(p_user uuid)
returns table (streak int, today_done boolean)
language sql stable security definer set search_path = ''
as $$
  with days as (
    select distinct dotty.berlin_day(created_at) as d from dotty.moments where user_id = p_user
  ),
  today as (select dotty.berlin_day(now()) as t),
  anchored as (
    -- the streak may end today or (if you haven't posted yet today) yesterday
    select case when exists (select 1 from days, today where d = t) then (select t from today)
                else (select t - 1 from today) end as a
  ),
  run as (
    select d, (select a from anchored) - d as back,
           row_number() over (order by d desc) - 1 as rn
    from days where d <= (select a from anchored)
  )
  select coalesce((select count(*)::int from run where back = rn), 0),
         exists (select 1 from days, today where d = t);
$$;

create or replace function dotty.user_points(p_user uuid, p_since timestamptz)
returns int language sql stable security definer set search_path = ''
as $$
  select
    10 * (select count(*) from dotty.moments where user_id = p_user and created_at >= p_since)::int
  + 15 * (select count(*) from (
            select place_id from dotty.moments where user_id = p_user
            group by place_id having min(created_at) >= p_since) f)::int
  + 2 * (select count(*) from dotty.reactions r join dotty.moments m on m.id = r.moment_id
          where m.user_id = p_user and r.user_id <> p_user and r.created_at >= p_since)::int
  + 2 * (select count(*) from dotty.comments c join dotty.moments m on m.id = c.moment_id
          where m.user_id = p_user and c.user_id <> p_user and c.created_at >= p_since)::int
  + 5 * least((select streak from dotty.user_streak(p_user)), 10);
$$;

-- streak + this week's points for a profile (anyone's: these are public)
create or replace function dotty.profile_score(p_user uuid)
returns table (streak int, today_done boolean, points int)
language sql stable security definer set search_path = ''
as $$
  select s.streak, s.today_done, dotty.user_points(p_user, dotty.week_start())
  from dotty.user_streak(p_user) s;
$$;

-- you + your friends, this week
create or replace function dotty.leaderboard_friends()
returns table (user_id uuid, username text, avatar_path text, points int, streak int, is_me boolean)
language sql stable security definer set search_path = ''
as $$
  with people as (
    select auth.uid() as id
    union
    select case when f.requester = auth.uid() then f.addressee else f.requester end
    from dotty.friendships f
    where f.status = 'accepted' and auth.uid() in (f.requester, f.addressee)
  )
  select p.id, p.username, p.avatar_path,
         dotty.user_points(p.id, dotty.week_start()),
         (select streak from dotty.user_streak(p.id)),
         p.id = auth.uid()
  from people x join dotty.profiles p on p.id = x.id
  order by 4 desc, 5 desc, p.username
  limit 100;
$$;

-- everyone who shared publicly in this city this week
create or replace function dotty.leaderboard_city(p_city text)
returns table (user_id uuid, username text, avatar_path text, points int, streak int, is_me boolean)
language sql stable security definer set search_path = ''
as $$
  with people as (
    select distinct m.user_id as id
    from dotty.moments m join dotty.places pl on pl.id = m.place_id
    where pl.city = p_city and m.visibility = 'public' and m.created_at >= dotty.week_start()
    union
    select auth.uid()
  )
  select p.id, p.username, p.avatar_path,
         dotty.user_points(p.id, dotty.week_start()),
         (select streak from dotty.user_streak(p.id)),
         p.id = auth.uid()
  from people x join dotty.profiles p on p.id = x.id
  order by 4 desc, 5 desc, p.username
  limit 50;
$$;

revoke execute on function dotty.user_streak(uuid), dotty.user_points(uuid, timestamptz), dotty.profile_score(uuid),
  dotty.leaderboard_friends(), dotty.leaderboard_city(text), dotty.week_start(), dotty.berlin_day(timestamptz) from public, anon;
grant execute on function dotty.user_streak(uuid), dotty.profile_score(uuid),
  dotty.leaderboard_friends(), dotty.leaderboard_city(text), dotty.week_start(), dotty.berlin_day(timestamptz) to authenticated;

create index if not exists moments_user_created_idx on dotty.moments (user_id, created_at desc);
create index if not exists reactions_created_idx on dotty.reactions (moment_id, created_at);
