-- Weekly recap ("Wochenrückblick"): every Sunday at 19:00 (Berlin) everyone
-- gets a push; the app then plays a story with your week in numbers, a
-- collage of the best moments, playful awards among your friends and the
-- ranking reveal. dotty.weekly_recap() computes all of it in one call.

-- ── points between two times (same rules as user_points) ─────────────────────

create or replace function dotty.user_streak_at(p_user uuid, p_at timestamptz)
returns int language sql stable security definer set search_path = ''
as $$
  with days as (
    select distinct dotty.berlin_day(created_at) as d from dotty.moments
    where user_id = p_user and created_at <= p_at
  ),
  anchor as (
    select case when exists (select 1 from days where d = dotty.berlin_day(p_at)) then dotty.berlin_day(p_at)
                else dotty.berlin_day(p_at) - 1 end as a
  ),
  run as (
    select (select a from anchor) - d as back, row_number() over (order by d desc) - 1 as rn
    from days where d <= (select a from anchor)
  )
  select coalesce((select count(*)::int from run where back = rn), 0);
$$;

create or replace function dotty.user_points_between(p_user uuid, p_from timestamptz, p_to timestamptz)
returns int language sql stable security definer set search_path = ''
as $$
  select
    10 * (select count(*) from dotty.moments where user_id = p_user and created_at >= p_from and created_at < p_to)::int
  + 15 * (select count(*) from (
            select place_id from dotty.moments where user_id = p_user and created_at < p_to
            group by place_id having min(created_at) >= p_from) f)::int
  + 2 * (select count(*) from dotty.reactions r join dotty.moments m on m.id = r.moment_id
          where m.user_id = p_user and r.user_id <> p_user and r.created_at >= p_from and r.created_at < p_to)::int
  + 2 * (select count(*) from dotty.comments c join dotty.moments m on m.id = c.moment_id
          where m.user_id = p_user and c.user_id <> p_user and c.created_at >= p_from and c.created_at < p_to)::int
  + 5 * least(dotty.user_streak_at(p_user, p_to), 10)
  + 50 * least((select count(*) from dotty.profiles where invited_by = p_user and created_at >= p_from and created_at < p_to), 20)::int
  + 5 * least((select count(*) from dotty.friendships
               where status = 'accepted' and accepted_at >= p_from and accepted_at < p_to and p_user in (requester, addressee)), 10)::int;
$$;

-- Monday 00:00 (Berlin) of the most recent recap: this week from Sunday 19:00 on, otherwise last week.
create or replace function dotty.recap_week_start(p_at timestamptz default now())
returns timestamptz language sql stable set search_path = ''
as $$
  select case
    when extract(isodow from p_at at time zone 'Europe/Berlin') = 7
         and extract(hour from p_at at time zone 'Europe/Berlin') >= 19
      then (date_trunc('week', p_at at time zone 'Europe/Berlin')) at time zone 'Europe/Berlin'
    else (date_trunc('week', p_at at time zone 'Europe/Berlin') - interval '7 days') at time zone 'Europe/Berlin'
  end;
$$;

-- ── the recap ────────────────────────────────────────────────────────────────

create or replace function dotty.weekly_recap(p_week_start timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  w0 timestamptz := coalesce(p_week_start, dotty.recap_week_start());
  w1 timestamptz := least(w0 + interval '7 days', now());
  p0 timestamptz := w0 - interval '7 days';
  result jsonb;
begin
  if me is null then raise exception 'not_signed_in'; end if;

  with people as (
    select me as id
    union
    select case when f.requester = me then f.addressee else f.requester end
    from dotty.friendships f where f.status = 'accepted' and me in (f.requester, f.addressee)
  ),
  wm as ( -- everyone's moments this week
    select m.*, (m.created_at at time zone 'Europe/Berlin') as local_at
    from dotty.moments m join people p on p.id = m.user_id
    where m.created_at >= w0 and m.created_at < w1
  ),
  stats as (
    select p.id,
      pr.username, pr.avatar_path,
      dotty.user_points_between(p.id, w0, w1) as points,
      dotty.user_points_between(p.id, p0, w0) as prev_points,
      (select count(*) from wm where wm.user_id = p.id)::int as moments,
      (select count(distinct place_id) from wm where wm.user_id = p.id)::int as places,
      (select count(*) from wm where wm.user_id = p.id
         and (extract(hour from wm.local_at) >= 22 or extract(hour from wm.local_at) < 5))::int as night,
      (select count(*) from wm where wm.user_id = p.id
         and extract(hour from wm.local_at) between 5 and 8)::int as early,
      (select count(*) from dotty.reactions r join dotty.moments m on m.id = r.moment_id
         where m.user_id = p.id and r.user_id <> p.id and r.created_at >= w0 and r.created_at < w1)::int as fire,
      (select count(*) from dotty.comments c
         where c.user_id = p.id and c.created_at >= w0 and c.created_at < w1)::int as yaps
    from people p join dotty.profiles pr on pr.id = p.id
  ),
  ranked as (
    select s.*,
      rank() over (order by s.points desc, s.moments desc) as rnk,
      rank() over (order by s.prev_points desc) as prev_rnk
    from stats s
  ),
  -- my numbers
  mine as (
    select
      (select count(*) from wm where user_id = me)::int as moments,
      (select count(distinct place_id) from wm where user_id = me)::int as places,
      (select count(*) from (select place_id from dotty.moments where user_id = me and created_at < w1
                               group by place_id having min(created_at) >= w0) n)::int as new_places,
      (select fire from stats where id = me) as fire,
      (select count(*) from dotty.comments c join dotty.moments m on m.id = c.moment_id
         where m.user_id = me and c.user_id <> me and c.created_at >= w0 and c.created_at < w1)::int as comments,
      dotty.user_streak_at(me, w1) as streak,
      (select to_char(local_at, 'ID')::int from wm where user_id = me
         group by 1 order by count(*) desc, 1 limit 1) as best_day,
      -- km between your moments, in order
      coalesce((select round(sum(d)::numeric, 1) from (
         select 6371 * 2 * asin(sqrt(
                  power(sin(radians(pl.lat - lag(pl.lat) over w) / 2), 2)
                + cos(radians(pl.lat)) * cos(radians(lag(pl.lat) over w))
                  * power(sin(radians(pl.lon - lag(pl.lon) over w) / 2), 2))) as d
         from wm join dotty.places pl on pl.id = wm.place_id
         where wm.user_id = me
         window w as (order by wm.created_at)) k), 0) as km
  ),
  awards as (
    select * from (
      (select 'main_character' as key, '🎬' as emoji, 'Main Character' as title, id, username, avatar_path, moments as value
         from stats where moments > 0 order by moments desc, fire desc, username limit 1)
      union all
      (select 'rizz', '🔥', 'Most Rizz', id, username, avatar_path, fire
         from stats where fire > 0 order by fire desc, moments desc, username limit 1)
      union all
      (select 'touch_grass', '🌳', 'Touch-Grass-Champion', id, username, avatar_path, places
         from stats where places > 1 order by places desc, moments desc, username limit 1)
      union all
      (select 'night_owl', '🦉', 'Nachteule', id, username, avatar_path, night
         from stats where night > 0 order by night desc, username limit 1)
      union all
      (select 'early_bird', '🐣', 'Early Bird', id, username, avatar_path, early
         from stats where early > 0 order by early desc, username limit 1)
      union all
      (select 'yapper', '💬', 'Yapper', id, username, avatar_path, yaps
         from stats where yaps > 1 order by yaps desc, username limit 1)
      union all
      (select 'ghost', '👻', 'Ghost', id, username, avatar_path, 0
         from stats where moments = 0 and id <> me order by points, username limit 1)
    ) a
  ),
  top_moments as (
    select wm.id, wm.photo_path, wm.created_at, wm.user_id, pr.username, pr.avatar_path,
           pl.name as place_name,
           (select count(*) from dotty.reactions r where r.moment_id = wm.id)::int as fire_count,
           (select count(*) from dotty.comments c where c.moment_id = wm.id)::int as comment_count
    from wm join dotty.profiles pr on pr.id = wm.user_id join dotty.places pl on pl.id = wm.place_id
    order by (select count(*) from dotty.reactions r where r.moment_id = wm.id)
           + 2 * (select count(*) from dotty.comments c where c.moment_id = wm.id) desc,
             wm.created_at desc
    limit 9
  ),
  top_place as (
    select pl.id, pl.name, pl.district, pl.city, count(*)::int as moments, count(distinct wm.user_id)::int as people
    from wm join dotty.places pl on pl.id = wm.place_id
    group by pl.id order by count(*) desc, count(distinct wm.user_id) desc limit 1
  )
  select jsonb_build_object(
    'week_start', w0,
    'week_end', w1,
    'friends', (select count(*) - 1 from people),
    'circle_moments', (select count(*) from wm),
    'me', (select to_jsonb(mine) || jsonb_build_object(
              'rank', (select rnk from ranked where id = me),
              'prev_rank', (select prev_rnk from ranked where id = me),
              'points', (select points from ranked where id = me)) from mine),
    'ranking', coalesce((select jsonb_agg(jsonb_build_object(
                  'user_id', id, 'username', username, 'avatar_path', avatar_path,
                  'points', points, 'moments', moments, 'rank', rnk, 'prev_rank', prev_rnk, 'is_me', id = me)
                  order by rnk, username) from ranked), '[]'::jsonb),
    'awards', coalesce((select jsonb_agg(jsonb_build_object(
                  'key', key, 'emoji', emoji, 'title', title, 'user_id', id, 'username', username,
                  'avatar_path', avatar_path, 'value', value, 'is_me', id = me)) from awards), '[]'::jsonb),
    'top_moments', coalesce((select jsonb_agg(to_jsonb(t)) from top_moments t), '[]'::jsonb),
    'top_place', (select to_jsonb(t) from top_place t)
  ) into result;
  return result;
end;
$$;

revoke execute on function dotty.weekly_recap(timestamptz) from public, anon;
grant execute on function dotty.weekly_recap(timestamptz) to authenticated;
revoke execute on function dotty.user_points_between(uuid, timestamptz, timestamptz) from public, anon;
revoke execute on function dotty.user_streak_at(uuid, timestamptz) from public, anon;

-- ── the Sunday push ─────────────────────────────────────────────────────────

alter table dotty.notifications drop constraint notifications_type_check;
alter table dotty.notifications add constraint notifications_type_check
  check (type = any (array['here', 'reaction', 'friend_request', 'friend_accepted', 'comment', 'message', 'recap']));

-- One "recap" notification per person who has a friend or posted this week.
-- Runs hourly on Sundays (cron is UTC) and only acts at 19:00 Berlin, so it
-- keeps working across summer/winter time. Never sends twice in a week.
create or replace function dotty.send_weekly_recaps()
returns int language plpgsql security definer set search_path = ''
as $$
declare n int;
begin
  if extract(isodow from now() at time zone 'Europe/Berlin') <> 7
     or extract(hour from now() at time zone 'Europe/Berlin') <> 19 then
    return 0;
  end if;
  insert into dotty.notifications (recipient_id, actor_id, type)
  select p.id, p.id, 'recap'
  from dotty.profiles p
  where (exists (select 1 from dotty.friendships f where f.status = 'accepted' and p.id in (f.requester, f.addressee))
         or exists (select 1 from dotty.moments m where m.user_id = p.id and m.created_at >= dotty.week_start()))
    and not exists (select 1 from dotty.notifications x
                    where x.recipient_id = p.id and x.type = 'recap' and x.created_at >= dotty.week_start());
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function dotty.send_weekly_recaps() from public, anon, authenticated;

create extension if not exists pg_cron;
select cron.schedule('dotty-weekly-recap', '0 16-19 * * 0', 'select dotty.send_weekly_recaps()');
