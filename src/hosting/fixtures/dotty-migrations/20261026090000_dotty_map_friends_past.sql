-- "Freunde" map: moments of you and your friends that are older than 24 h
-- appear as faded photo bubbles. Like the "Alle" map, the visible area is a
-- grid and every cell gives back only its best moment, so there are never
-- thousands of them.
create or replace function dotty.map_friends_past_best(
  p_min_lat double precision, p_min_lon double precision,
  p_max_lat double precision, p_max_lon double precision,
  p_cols int default 16, p_rows int default 26,
  p_recent_hours int default 24
)
returns table (card dotty.moment_cards, activity int)
language sql stable security invoker set search_path = ''
as $$
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
      -- reactions count, newer wins a tie, very old fades slowly
      (m.fire_count + 2 * m.comment_count + 1)::float8
        / power(extract(epoch from now() - m.created_at) / 86400 + 1, 0.5) as score
    from dotty.moment_cards m
    where m.lat between p_min_lat and p_max_lat
      and m.lon between p_min_lon and p_max_lon
      and m.created_at <= now() - make_interval(hours => p_recent_hours)
      and m.relation in ('me', 'friend')
  ),
  ranked as (
    select c.m, c.score,
      row_number() over (partition by c.gx, c.gy order by c.score desc, (c.m).created_at desc) as rn,
      count(*) over (partition by c.gx, c.gy) as act
    from c
  )
  select r.m, r.act::int from ranked r where r.rn = 1
  order by r.score desc
  limit 400;
$$;
revoke execute on function dotty.map_friends_past_best(double precision, double precision, double precision, double precision, int, int, int) from public, anon;
grant execute on function dotty.map_friends_past_best(double precision, double precision, double precision, double precision, int, int, int) to authenticated;
