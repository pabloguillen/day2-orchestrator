-- The friends map's trail: one row per place where you or a friend have a
-- moment, with the visit that represents the place (yours first, then the
-- newest), so the app can show a dot, and from street level a small photo.
-- Runs with the caller's rights (moments read policy applies).
create or replace function dotty.map_trail(
  p_min_lat double precision, p_min_lon double precision,
  p_max_lat double precision, p_max_lon double precision
)
returns table(
  place_id uuid, lat double precision, lon double precision,
  mine boolean, recent boolean, visits integer, last_at timestamptz,
  moment_id uuid, photo_path text, user_id uuid, username text, avatar_path text
)
language sql
stable
set search_path = ''
as $$
  with v as (
    select m.id, m.place_id, m.user_id, m.photo_path, m.created_at, pl.lat, pl.lon,
           (m.user_id = auth.uid()) as is_me
    from dotty.moments m
    join dotty.places pl on pl.id = m.place_id
    where pl.lat between p_min_lat and p_max_lat
      and pl.lon between p_min_lon and p_max_lon
      and (m.user_id = auth.uid() or dotty.is_my_friend(m.user_id))
  ),
  agg as (
    select place_id, bool_or(is_me) as mine, bool_or(created_at > now() - interval '24 hours') as recent,
           count(*)::int as visits, max(created_at) as last_at
    from v group by place_id
  ),
  rep as (
    select distinct on (place_id) place_id, id, user_id, photo_path, lat, lon
    from v order by place_id, is_me desc, created_at desc
  )
  select a.place_id, r.lat, r.lon, a.mine, a.recent, a.visits, a.last_at,
         r.id, r.photo_path, r.user_id, p.username, p.avatar_path
  from agg a
  join rep r on r.place_id = a.place_id
  join dotty.profiles p on p.id = r.user_id
  order by a.mine desc, a.last_at desc
  limit 1500;
$$;
revoke all on function dotty.map_trail(double precision, double precision, double precision, double precision) from public, anon;
grant execute on function dotty.map_trail(double precision, double precision, double precision, double precision) to authenticated;
