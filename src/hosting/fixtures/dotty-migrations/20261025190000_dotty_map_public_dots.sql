-- Small dots for the "Alle" map: every public moment of the last p_hours in the
-- visible area (position only), so the moments that aren't the best of their
-- area still show up as dots and grow into pins when you zoom in.
create or replace function dotty.map_public_dots(
  p_min_lat double precision, p_min_lon double precision,
  p_max_lat double precision, p_max_lon double precision,
  p_hours int default 24
)
returns table (id uuid, lat double precision, lon double precision)
language sql stable security invoker set search_path = ''
as $$
  select m.id, pl.lat, pl.lon
  from dotty.moments m
  join dotty.places pl on pl.id = m.place_id
  where pl.lat between p_min_lat and p_max_lat
    and pl.lon between p_min_lon and p_max_lon
    and m.created_at > now() - make_interval(hours => p_hours)
    and (m.visibility = 'public' or m.user_id = auth.uid())
  order by m.created_at desc
  limit 800;
$$;

revoke execute on function dotty.map_public_dots(double precision, double precision, double precision, double precision, int) from public, anon;
grant execute on function dotty.map_public_dots(double precision, double precision, double precision, double precision, int) to authenticated;
