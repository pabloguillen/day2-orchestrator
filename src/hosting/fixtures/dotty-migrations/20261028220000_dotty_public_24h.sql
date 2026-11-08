-- Public moments are public for 24 hours only.
-- After that only the author and their friends can still see them (on the
-- "Freunde" map as faded circles, in the feed, on the profile). Everyone else
-- loses access everywhere at once, because the rule lives in the read policy:
-- map, place pages, profiles, moment links, comments and reactions all follow it.

create or replace function dotty.can_see_moment(m_user uuid, m_visibility text, m_created_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select m_user = auth.uid()
      or (not dotty.is_blocked(auth.uid(), m_user)
          and (dotty.are_friends(auth.uid(), m_user)
               or (m_visibility = 'public' and m_created_at > now() - interval '24 hours')));
$$;
revoke all on function dotty.can_see_moment(uuid, text, timestamptz) from public, anon;
grant execute on function dotty.can_see_moment(uuid, text, timestamptz) to authenticated;

alter policy moments_read on dotty.moments
  using (dotty.can_see_moment(user_id, visibility, created_at));

-- counts on place pages and profiles follow the same rule
create or replace function dotty.place_stats(p_place_id uuid)
returns table(moments_total integer, friends_been integer, mine integer)
language sql
stable
security definer
set search_path = ''
as $$
  select
    count(*) filter (where dotty.can_see_moment(m.user_id, m.visibility, m.created_at))::int,
    count(distinct m.user_id) filter (where dotty.are_friends(auth.uid(), m.user_id))::int,
    count(*) filter (where m.user_id = auth.uid())::int
  from dotty.moments m where m.place_id = p_place_id;
$$;

create or replace function dotty.profile_stats(p_user uuid)
returns table(moments integer, friends integer, places integer)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select count(*) from dotty.moments m where m.user_id = p_user
       and (p_user = auth.uid() or dotty.can_see_moment(m.user_id, m.visibility, m.created_at)))::int,
    case when p_user = auth.uid() or dotty.are_friends(auth.uid(), p_user)
         then (select count(*) from dotty.friend_ids(p_user))::int end,
    (select count(distinct m.place_id) from dotty.moments m where m.user_id = p_user
       and (p_user = auth.uid() or dotty.can_see_moment(m.user_id, m.visibility, m.created_at)))::int;
$$;

-- "Alle" feed: places with public moments of the last 24 hours (was: since midnight)
create or replace function dotty.public_places(p_lat double precision, p_lon double precision, p_radius integer default 5000)
returns table(place_id uuid, name text, category text, district text, distance_m double precision, moments_today integer, here_now integer, cover_path text)
language sql
stable
security definer
set search_path = ''
as $$
  select pl.id, pl.name, pl.category, pl.district,
         public.st_distance(pl.geog, public.st_setsrid(public.st_makepoint(p_lon, p_lat), 4326)::public.geography),
         count(*)::int,
         count(distinct m.user_id) filter (where m.created_at > now() - interval '60 minutes')::int,
         (array_agg(m.photo_path order by m.created_at desc))[1]
  from dotty.moments m
  join dotty.places pl on pl.id = m.place_id
  where m.visibility = 'public'
    and m.created_at > now() - interval '24 hours'
    and not dotty.is_blocked(auth.uid(), m.user_id)
    and public.st_dwithin(pl.geog, public.st_setsrid(public.st_makepoint(p_lon, p_lat), 4326)::public.geography, p_radius)
  group by pl.id
  order by 7 desc, 6 desc
  limit 40;
$$;
