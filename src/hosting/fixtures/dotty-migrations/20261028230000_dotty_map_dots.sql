-- Every place with a moment in view, as a small dot, so nothing simply vanishes
-- from the map when pins and bubbles run out of room.
--   'public'  : public moments of the last 24 h (plus your own)
--   'friends' : you and your friends, any age (older ones are drawn faded)
-- One row per place. Runs with the caller's rights, so the moments read policy
-- (blocks, friends-only, public for 24 h) applies as everywhere else.
create or replace function dotty.map_dots(
  p_scope text,
  p_min_lat double precision, p_min_lon double precision,
  p_max_lat double precision, p_max_lon double precision
)
returns table(place_id uuid, lat double precision, lon double precision, mine boolean, recent boolean)
language sql
stable
set search_path = ''
as $$
  select pl.id, pl.lat, pl.lon,
         bool_or(m.user_id = auth.uid()),
         bool_or(m.created_at > now() - interval '24 hours')
  from dotty.moments m
  join dotty.places pl on pl.id = m.place_id
  where pl.lat between p_min_lat and p_max_lat
    and pl.lon between p_min_lon and p_max_lon
    and case when p_scope = 'public'
             then m.created_at > now() - interval '24 hours'
                  and (m.visibility = 'public' or m.user_id = auth.uid())
             else m.user_id = auth.uid() or dotty.is_my_friend(m.user_id)
        end
  group by pl.id
  order by max(m.created_at) desc
  limit 1500;
$$;
revoke all on function dotty.map_dots(text, double precision, double precision, double precision, double precision) from public, anon;
grant execute on function dotty.map_dots(text, double precision, double precision, double precision, double precision) to authenticated;
