-- Real places only, from two open sources.
--
-- Places now come from OpenStreetMap (dotty.osm_places, public.places_osm)
-- and from Foursquare's open places dataset (FSQ OS Places, Apache 2.0,
-- imported into dotty.fsq_places by scripts/places/import-fsq.sh). Nobody can
-- create a place with a made-up name any more: typing a name searches both
-- sources around you (find_places), and only a match there can be posted.
-- The automatic "Genau hier" area labels are gone too.

create extension if not exists pg_trgm with schema extensions;

create table if not exists dotty.fsq_places (
  source_id  text primary key,          -- fsq_place_id
  name       text not null,
  category   text not null default 'other',
  address    text,
  city       text,
  lat        double precision not null,
  lon        double precision not null,
  geog       public.geography generated always as (public.st_setsrid(public.st_makepoint(lon, lat), 4326)::public.geography) stored,
  fetched_at timestamptz not null default now()
);
create index if not exists fsq_places_geog_idx on dotty.fsq_places using gist (geog);
alter table dotty.fsq_places enable row level security; -- only read through the functions below
revoke all on dotty.fsq_places from anon, authenticated;

alter table dotty.places drop constraint places_source_check;
alter table dotty.places add constraint places_source_check check (source = any (array['osm', 'fsq', 'user']));

-- no more user places → no more name checks needed
drop trigger if exists user_place_check on dotty.places;
do $$ begin perform cron.unschedule('dotty-recheck-places'); exception when others then null; end $$;

-- "same place?" for names: case, accents and punctuation don't matter
create or replace function dotty.name_key(t text)
returns text language sql immutable set search_path = ''
as $$ select btrim(regexp_replace(lower(public.unaccent(coalesce(t, ''))), '[^a-z0-9]+', ' ', 'g')) $$;

create or replace function dotty.name_sim(a text, b text)
returns real language sql immutable set search_path = ''
as $$
  select greatest(
    extensions.similarity(dotty.name_key(a), dotty.name_key(b)),
    case when length(dotty.name_key(b)) >= 3 and dotty.name_key(a) like '%' || dotty.name_key(b) || '%' then 0.6 else 0 end
  )::real
$$;

-- ── everything nearby: OSM + Foursquare (Foursquare only where OSM has nothing similar) ──

drop function if exists dotty.nearby_places(double precision, double precision, integer);
create or replace function dotty.nearby_places(p_lat double precision, p_lon double precision, p_radius integer default 100, p_limit integer default 40)
returns table(ref jsonb, name text, category text, address text, lat double precision, lon double precision, distance_m double precision)
language sql stable security definer set search_path = ''
as $function$
  with here as (
    select public.st_setsrid(public.st_makepoint(p_lon, p_lat), 4326) as g
  ),
  own as (
    select jsonb_build_object('id', pl.id) as ref, pl.name, pl.category, pl.address, pl.lat, pl.lon,
           public.st_distance(pl.geog, (select g from here)::public.geography) as distance_m,
           pl.source, pl.source_id
    from dotty.places pl
    where public.st_dwithin(pl.geog, (select g from here)::public.geography, p_radius)
      and (pl.source in ('osm', 'fsq') or pl.created_by = auth.uid()
           or exists (select 1 from dotty.moments m
                      where m.place_id = pl.id and dotty.can_see_moment(m.user_id, m.visibility)))
  ),
  osm as (
    select jsonb_build_object('source', 'osm', 'source_id', o.place_id) as ref, o.name,
           coalesce(o.type, 'other') as category, coalesce(o.local_address, o.address) as address,
           o.lat, o.lon,
           public.st_distance(o.geom::public.geography, (select g from here)::public.geography) as distance_m,
           o.place_id as source_id
    from public.places_osm o
    where o.geom operator(public.&&) public.st_expand((select g from here), p_radius / 70000.0)
      and not o.is_deprecated and not o."isPrivate"
      and public.st_dwithin(o.geom::public.geography, (select g from here)::public.geography, p_radius)
      and not exists (select 1 from own where own.source = 'osm' and own.source_id = o.place_id)
  ),
  live as (
    select jsonb_build_object('source', 'osm', 'source_id', c.source_id) as ref, c.name, c.category, c.address,
           c.lat, c.lon, public.st_distance(c.geog, (select g from here)::public.geography) as distance_m,
           c.source_id
    from dotty.osm_places c
    where public.st_dwithin(c.geog, (select g from here)::public.geography, p_radius)
      and not exists (select 1 from own where own.source = 'osm' and own.source_id = c.source_id)
      and not exists (select 1 from public.places_osm o
                      where o.geom operator(public.&&) public.st_expand((select g from here), p_radius / 50000.0)
                        and o.osm_type = c.osm_type and o.osm_id = c.osm_id)
  ),
  base as (
    select ref, name, category, address, lat, lon, distance_m from own
    union all select ref, name, category, address, lat, lon, distance_m from osm
    union all select ref, name, category, address, lat, lon, distance_m from live
  ),
  fsq as (
    select jsonb_build_object('source', 'fsq', 'source_id', f.source_id) as ref, f.name, f.category, f.address,
           f.lat, f.lon, public.st_distance(f.geog, (select g from here)::public.geography) as distance_m
    from dotty.fsq_places f
    where public.st_dwithin(f.geog, (select g from here)::public.geography, p_radius)
      and not exists (select 1 from own where own.source = 'fsq' and own.source_id = f.source_id)
      -- the same place already known from OSM (similar name close by)
      and not exists (select 1 from base b
                      where dotty.name_sim(b.name, f.name) > 0.45
                        and public.st_dwithin(public.st_setsrid(public.st_makepoint(b.lon, b.lat), 4326)::public.geography, f.geog, 80))
  )
  select ref, name, category, address, lat, lon, distance_m from base
  union all
  select ref, name, category, address, lat, lon, distance_m from fsq
  order by distance_m
  limit p_limit;
$function$;
revoke execute on function dotty.nearby_places(double precision, double precision, integer, integer) from public, anon;
grant execute on function dotty.nearby_places(double precision, double precision, integer, integer) to authenticated, service_role;

-- ── "Ort nicht dabei?": find a typed name around you in OSM + Foursquare ──

create or replace function dotty.find_places(p_q text, p_lat double precision, p_lon double precision, p_radius integer default 150)
returns table(ref jsonb, name text, category text, address text, lat double precision, lon double precision, distance_m double precision, score real)
language sql stable security definer set search_path = ''
as $function$
  with c as (
    select n.ref, n.name, n.category, n.address, n.lat, n.lon, n.distance_m,
           dotty.name_sim(n.name, p_q) as score
    from dotty.nearby_places(p_lat, p_lon, least(greatest(p_radius, 50), 300), 3000) n
    where length(dotty.name_key(p_q)) >= 2
  )
  select ref, name, category, address, lat, lon, distance_m, score
  from c where score >= 0.3
  order by score desc, distance_m
  limit 10;
$function$;
revoke execute on function dotty.find_places(text, double precision, double precision, integer) from public, anon;
grant execute on function dotty.find_places(text, double precision, double precision, integer) to authenticated;

-- ── posting: OSM or Foursquare places only ───────────────────────────────────

create or replace function dotty.post_moment(p_place jsonb, p_caption text, p_photo_path text, p_visibility text, p_lat double precision, p_lon double precision, p_accuracy double precision, p_district text default null, p_city text default null)
returns dotty.moments
language plpgsql security definer set search_path = ''
as $function$
declare
  uid       uuid := auth.uid();
  v_place   dotty.places;
  v_osm     record;
  v_fsq     dotty.fsq_places;
  v_dist    double precision;
  v_moment  dotty.moments;
  v_prev    record;
  max_dist  constant double precision := 100;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not exists (select 1 from dotty.profiles where id = uid) then
    raise exception 'profile_missing' using errcode = 'P0001';
  end if;
  if p_visibility not in ('friends', 'public') then
    raise exception 'bad_visibility' using errcode = '22023';
  end if;
  if p_photo_path is null or split_part(p_photo_path, '/', 1) <> uid::text then
    raise exception 'bad_photo_path' using errcode = '22023';
  end if;
  if p_accuracy is null or p_accuracy > 150 then
    raise exception 'location_inaccurate' using errcode = 'P0001';
  end if;
  if (select count(*) from dotty.moments where user_id = uid and created_at > now() - interval '1 day') >= 30 then
    raise exception 'too_many_moments' using errcode = 'P0001';
  end if;

  -- no teleporting: compared with your last moment, faster than a plane is not real
  select m.lat, m.lon, m.created_at into v_prev
    from dotty.moments m where m.user_id = uid order by m.created_at desc limit 1;
  if found and v_prev.lat is not null then
    v_dist := public.st_distance(
      public.st_setsrid(public.st_makepoint(v_prev.lon, v_prev.lat), 4326)::public.geography,
      public.st_setsrid(public.st_makepoint(p_lon, p_lat), 4326)::public.geography);
    if v_dist > 50000
       and v_dist / 1000 / greatest(extract(epoch from now() - v_prev.created_at) / 3600, 0.01) > 1000 then
      raise exception 'location_implausible' using errcode = 'P0001';
    end if;
  end if;

  if p_place ? 'id' then
    select * into v_place from dotty.places where id = (p_place->>'id')::uuid;
  elsif p_place->>'source' = 'osm' then
    select * into v_place from dotty.places where source = 'osm' and source_id = p_place->>'source_id';
    if not found then
      select o.place_id, o.name, coalesce(o.type, 'other') as category,
             coalesce(o.local_address, o.address) as address, o.admin_city, o.lat, o.lon
        into v_osm
        from public.places_osm o where o.place_id = p_place->>'source_id';
      if not found then
        select c.source_id as place_id, c.name, c.category, c.address, c.city as admin_city, c.lat, c.lon
          into v_osm
          from dotty.osm_places c where c.source_id = p_place->>'source_id';
      end if;
      if not found then raise exception 'place_not_found' using errcode = 'P0002'; end if;
      insert into dotty.places (source, source_id, name, category, address, district, city, lat, lon, checked_at)
      values ('osm', v_osm.place_id, v_osm.name, v_osm.category, v_osm.address, p_district,
              coalesce(v_osm.admin_city, p_city), v_osm.lat, v_osm.lon, now())
      on conflict (source, source_id) do update set name = excluded.name
      returning * into v_place;
    end if;
  elsif p_place->>'source' = 'fsq' then
    select * into v_place from dotty.places where source = 'fsq' and source_id = p_place->>'source_id';
    if not found then
      select * into v_fsq from dotty.fsq_places where source_id = p_place->>'source_id';
      if not found then raise exception 'place_not_found' using errcode = 'P0002'; end if;
      insert into dotty.places (source, source_id, name, category, address, district, city, lat, lon, checked_at)
      values ('fsq', v_fsq.source_id, left(v_fsq.name, 80), v_fsq.category, v_fsq.address, p_district,
              coalesce(v_fsq.city, p_city), v_fsq.lat, v_fsq.lon, now())
      on conflict (source, source_id) do update set name = excluded.name
      returning * into v_place;
    end if;
  end if;
  -- anything else (a typed name that isn't in OSM or Foursquare) is not a place

  if v_place.id is null then raise exception 'place_not_found' using errcode = 'P0002'; end if;

  v_dist := public.st_distance(
    v_place.geog,
    public.st_setsrid(public.st_makepoint(p_lon, p_lat), 4326)::public.geography
  );
  if v_dist > max_dist + least(p_accuracy, 50) then
    raise exception 'too_far' using errcode = 'P0001', detail = round(v_dist)::text;
  end if;

  if v_place.district is null and p_district is not null then
    update dotty.places set district = p_district, city = coalesce(city, p_city)
     where id = v_place.id returning * into v_place;
  end if;

  insert into dotty.moments (user_id, place_id, caption, photo_path, visibility, lat, lon, accuracy_m)
  values (uid, v_place.id, nullif(trim(p_caption), ''), p_photo_path, p_visibility, p_lat, p_lon, p_accuracy)
  returning * into v_moment;

  insert into dotty.notifications (recipient_id, actor_id, type, moment_id, place_id)
  select fid, uid, 'here', v_moment.id, v_place.id from dotty.friend_ids(uid) fid;

  return v_moment;
end;
$function$;
