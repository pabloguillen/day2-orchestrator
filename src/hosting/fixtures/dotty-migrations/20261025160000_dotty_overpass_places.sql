-- Places from Overpass on demand (instead of importing all of OpenStreetMap).
-- The places-near Edge Function fetches named POIs for ~200 m tiles around the
-- user the first time someone opens the camera there, and caches them here for
-- 30 days. Only the server writes these tables, so posts can still only be
-- pinned to real OSM places.

create table dotty.osm_places (
  source_id  text primary key,               -- 'N123' / 'W456' / 'R789'
  osm_type   text not null check (osm_type in ('N', 'W', 'R')),
  osm_id     bigint not null,
  name       text not null,
  category   text not null,
  address    text,
  city       text,
  lat        double precision not null,
  lon        double precision not null,
  geog       public.geography(Point, 4326)
             generated always as (public.st_setsrid(public.st_makepoint(lon, lat), 4326)::public.geography) stored,
  fetched_at timestamptz not null default now()
);
create index osm_places_geog_idx on dotty.osm_places using gist (geog);
alter table dotty.osm_places enable row level security;

create table dotty.osm_tiles (
  tile       text primary key,               -- '<lat index>:<lon index>' on a 0.002° × 0.003° grid
  fetched_at timestamptz not null default now(),
  places     int not null default 0
);
alter table dotty.osm_tiles enable row level security;

grant select, insert, update, delete on dotty.osm_places, dotty.osm_tiles to service_role;

create or replace function dotty.nearby_places(p_lat double precision, p_lon double precision, p_radius int default 100)
returns table (ref jsonb, name text, category text, address text, lat double precision, lon double precision, distance_m double precision)
language sql stable security definer set search_path = ''
as $$
  with here as (
    select public.st_setsrid(public.st_makepoint(p_lon, p_lat), 4326) as g
  ),
  own as (
    select jsonb_build_object('id', pl.id) as ref, pl.name, pl.category, pl.address, pl.lat, pl.lon,
           public.st_distance(pl.geog, (select g from here)::public.geography) as distance_m,
           pl.source_id
    from dotty.places pl
    where public.st_dwithin(pl.geog, (select g from here)::public.geography, p_radius)
      and (pl.source = 'osm' or pl.created_by = auth.uid()
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
      and not exists (select 1 from own where own.source_id = o.place_id)
  ),
  live as (
    -- places fetched from Overpass outside the imported area
    select jsonb_build_object('source', 'osm', 'source_id', c.source_id) as ref, c.name, c.category, c.address,
           c.lat, c.lon, public.st_distance(c.geog, (select g from here)::public.geography) as distance_m,
           c.source_id
    from dotty.osm_places c
    where public.st_dwithin(c.geog, (select g from here)::public.geography, p_radius)
      and not exists (select 1 from own where own.source_id = c.source_id)
      and not exists (select 1 from public.places_osm o
                      where o.geom operator(public.&&) public.st_expand((select g from here), p_radius / 50000.0)
                        and o.osm_type = c.osm_type and o.osm_id = c.osm_id)
  )
  select ref, name, category, address, lat, lon, distance_m from own
  union all
  select ref, name, category, address, lat, lon, distance_m from osm
  union all
  select ref, name, category, address, lat, lon, distance_m from live
  order by distance_m
  limit 30;
$$;

create or replace function dotty.post_moment(
  p_place      jsonb,
  p_caption    text,
  p_photo_path text,
  p_visibility text,
  p_lat        double precision,
  p_lon        double precision,
  p_accuracy   double precision,
  p_district   text default null,
  p_city       text default null
)
returns dotty.moments
language plpgsql volatile security definer set search_path = ''
as $$
declare
  uid       uuid := auth.uid();
  v_place   dotty.places;
  v_osm     record;
  v_dist    double precision;
  v_moment  dotty.moments;
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

  -- resolve the place
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
        -- fetched live from Overpass by the places-near function (server-side only)
        select c.source_id as place_id, c.name, c.category, c.address, c.city as admin_city, c.lat, c.lon
          into v_osm
          from dotty.osm_places c where c.source_id = p_place->>'source_id';
      end if;
      if not found then raise exception 'place_not_found' using errcode = 'P0002'; end if;
      insert into dotty.places (source, source_id, name, category, address, district, city, lat, lon)
      values ('osm', v_osm.place_id, v_osm.name, v_osm.category, v_osm.address, p_district,
              coalesce(v_osm.admin_city, p_city), v_osm.lat, v_osm.lon)
      on conflict (source, source_id) do update set name = excluded.name
      returning * into v_place;
    end if;
  elsif p_place->>'source' = 'user' then
    insert into dotty.places (source, name, category, district, city, lat, lon, created_by)
    values ('user', left(trim(p_place->>'name'), 80), coalesce(p_place->>'category', 'other'),
            p_district, p_city, p_lat, p_lon, uid)
    returning * into v_place;
  end if;

  if v_place.id is null then raise exception 'place_not_found' using errcode = 'P0002'; end if;

  -- the core rule: you have to be there
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

  -- every friend gets "<you> ist hier · <place>"
  insert into dotty.notifications (recipient_id, actor_id, type, moment_id, place_id)
  select fid, uid, 'here', v_moment.id, v_place.id from dotty.friend_ids(uid) fid;

  return v_moment;
end;
$$;
