-- "Alle" map: you and your friends always come first. Your and your friends'
-- active moments are included (also friends-only ones you can see anyway) and
-- win their grid cell over strangers' moments, so they become the pin there.
create or replace function dotty.map_public_best(p_min_lat double precision, p_min_lon double precision, p_max_lat double precision, p_max_lon double precision, p_cols integer default 6, p_rows integer default 9, p_hours integer default 24)
returns table(card dotty.moment_cards, activity integer, live integer)
language sql
stable
set search_path to ''
as $function$
  with box as (
    select ln(tan(pi() / 4 + radians(greatest(least(p_min_lat, 85), -85)) / 2)) as y0,
           ln(tan(pi() / 4 + radians(greatest(least(p_max_lat, 85), -85)) / 2)) as y1
  ),
  c as (
    select m,
      greatest(0, least(p_cols - 1, floor((m.lon - p_min_lon) / nullif(p_max_lon - p_min_lon, 0) * p_cols)))::int as gx,
      greatest(0, least(p_rows - 1, floor(
        (ln(tan(pi() / 4 + radians(m.lat) / 2)) - (select y0 from box))
        / nullif((select y1 - y0 from box), 0) * p_rows)))::int as gy,
      (m.fire_count + 2 * m.comment_count + 1)::float8
        / power(extract(epoch from now() - m.created_at) / 3600 + 2, 1.2)
        * case m.relation when 'me' then 1e6 when 'friend' then 1e3 else 1 end as score
    from dotty.moment_cards m
    where m.lat between p_min_lat and p_max_lat
      and m.lon between p_min_lon and p_max_lon
      and m.created_at > now() - make_interval(hours => p_hours)
      and (m.visibility = 'public' or m.relation in ('me', 'friend'))
  ),
  ranked as (
    select c.m, c.score,
      row_number() over (partition by c.gx, c.gy order by c.score desc, (c.m).created_at desc) as rn,
      count(*) over (partition by c.gx, c.gy) as act,
      count(*) filter (where (c.m).created_at > now() - interval '60 minutes') over (partition by c.gx, c.gy) as lv
    from c
  )
  select r.m, r.act::int, r.lv::int from ranked r where r.rn = 1
  order by r.score desc;
$function$;

-- "Alle" map dots: every place with an active (24 h) moment you can see there,
-- with whose it is: 'me' wins over 'friend' wins over 'other'.
create or replace function dotty.map_active_dots(
  p_min_lat double precision, p_min_lon double precision,
  p_max_lat double precision, p_max_lon double precision
)
returns table(place_id uuid, lat double precision, lon double precision, owner text)
language sql
stable
set search_path = ''
as $$
  select pl.id, pl.lat, pl.lon,
         case when bool_or(m.user_id = auth.uid()) then 'me'
              when bool_or(dotty.is_my_friend(m.user_id)) then 'friend'
              else 'other' end
  from dotty.moments m
  join dotty.places pl on pl.id = m.place_id
  where pl.lat between p_min_lat and p_max_lat
    and pl.lon between p_min_lon and p_max_lon
    and m.created_at > now() - interval '24 hours'
    and (m.visibility = 'public' or m.user_id = auth.uid() or dotty.is_my_friend(m.user_id))
  group by pl.id
  order by max(m.created_at) desc
  limit 1500;
$$;
revoke all on function dotty.map_active_dots(double precision, double precision, double precision, double precision) from public, anon;
grant execute on function dotty.map_active_dots(double precision, double precision, double precision, double precision) to authenticated;
