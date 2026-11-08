-- Suggested places: when a real place isn't in OpenStreetMap or Foursquare,
-- people can suggest it. A suggestion starts "unverified":
--   • moments there are friends-only (so only the poster's friends see the place),
--   • it never shows on the "Alle" map or in public rankings,
--   • the same name close by is one suggestion, not many.
-- It becomes a normal, public place when 3 different people have posted
-- there, or when OSM / Foursquare has a place with a similar name next to it
-- (checked after every post and nightly, so new imports confirm suggestions).

alter table dotty.places add column if not exists verified boolean not null default true;

-- ── "same place?" both ways round: "Aklé" = "Aklé - Lebanese Cuisine" ──────────
create or replace function dotty.name_sim(a text, b text)
returns real language sql immutable set search_path = ''
as $$
  select greatest(
    extensions.similarity(dotty.name_key(a), dotty.name_key(b)),
    case when least(length(dotty.name_key(a)), length(dotty.name_key(b))) >= 3
          and (dotty.name_key(a) like '%' || dotty.name_key(b) || '%'
               or dotty.name_key(b) like '%' || dotty.name_key(a) || '%') then 0.6 else 0 end
  )::real
$$;

-- ── how many different people posted at a place ──────────────────────────────
create or replace function dotty.place_posters(p_place uuid)
returns int language sql stable security definer set search_path = ''
as $$ select count(distinct user_id)::int from dotty.moments where place_id = p_place $$;

-- ── confirm suggestions: 3 people, or OSM / Foursquare knows the place ────────
create or replace function dotty.verify_suggested_places(p_place uuid default null)
returns int language plpgsql security definer set search_path = ''
as $$
declare n int := 0; r record; v_cat text;
begin
  for r in select pl.* from dotty.places pl
           where pl.source = 'user' and not pl.verified and (p_place is null or pl.id = p_place) loop
    v_cat := null;
    if dotty.place_posters(r.id) >= 3 then
      v_cat := r.category;
    else
      select category into v_cat from (
        select o.category, o.name, o.geog from dotty.osm_places o
         where public.st_dwithin(o.geog, r.geog, 75)
        union all
        select f.category, f.name, f.geog from dotty.fsq_places f
         where public.st_dwithin(f.geog, r.geog, 75)
      ) s where dotty.name_sim(s.name, r.name) > 0.6
      order by dotty.name_sim(s.name, r.name) desc limit 1;
    end if;
    if v_cat is not null then
      update dotty.places set verified = true, checked_at = now(),
             category = case when category = 'other' then v_cat else category end
       where id = r.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;
revoke execute on function dotty.verify_suggested_places(uuid) from public, anon, authenticated;
select cron.schedule('dotty-verify-suggestions', '20 3 * * *', 'select dotty.verify_suggested_places()');

-- ── what a suggested name may look like ────────────────────────────────────
create or replace function dotty.clean_place_name(p text)
returns text language plpgsql immutable set search_path = ''
as $$
declare v text := left(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g'), 60);
begin
  if length(v) < 2 or v !~ '[[:alpha:]]' then return null; end if;
  if v ~* '(https?:|www\.|@|\.(com|de|net|org|io|app)\b|\d{5,})' then return null; end if;
  if v ~* '(fick|fuck|porn|nackt|nude|sex|hure|whore|nazi|hitler|nigg|kanake|schwuchtel|fotze|cunt|wichs)' then return null; end if;
  return v;
end;
$$;

-- ── nearby / search now say whether a place is still a suggestion ─────────────
drop function if exists dotty.find_places(text, double precision, double precision, integer);
drop function if exists dotty.nearby_places(double precision, double precision, integer, integer);

create function dotty.nearby_places(p_lat double precision, p_lon double precision, p_radius integer default 100, p_limit integer default 40)
returns table(ref jsonb, name text, category text, address text, lat double precision, lon double precision, distance_m double precision, verified boolean, posters int)
language sql stable security definer set search_path = ''
as $function$
  with here as (
    select public.st_setsrid(public.st_makepoint(p_lon, p_lat), 4326) as g
  ),
  own as (
    select jsonb_build_object('id', pl.id) as ref, pl.name, pl.category, pl.address, pl.lat, pl.lon,
           public.st_distance(pl.geog, (select g from here)::public.geography) as distance_m,
           pl.source, pl.source_id, pl.verified,
           case when pl.verified then null else dotty.place_posters(pl.id) end as posters
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
      -- the old Berlin table also has doctors, kindergartens, bus stops …: only places to hang out
      and o.type = any(array['amusement_arcade','aquarium','art','arts_centre','artwork','attraction','bakery','bar','bay','beach','beach_resort','biergarten','books','bowling_alley','bridge','cafe','camp_site','casino','castle','chocolate','church','cinema','city_gate','cliff','coffee','college','community_centre','confectionery','dance','deli','department_store','escape_game','farm','fast_food','fitness_centre','florist','food_court','fort','fountain','gallery','garden','gift','hostel','hotel','ice_cream','ice_rink','kiosk','library','lighthouse','mall','manor','marina','marketplace','memorial','miniature_golf','monument','museum','music','nature_reserve','nightclub','observation_tower','palace','park','pastry','peak','picnic_site','pier','place_of_worship','planetarium','playground','pub','restaurant','ruins','second_hand','sports_centre','spring','square','stadium','station','swimming_pool','tea','theatre','theme_park','tower','townhall','university','viewpoint','water_park','waterfall','wine','zoo'])
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
    select ref, name, category, address, lat, lon, distance_m, verified, posters from own
    union all select ref, name, category, address, lat, lon, distance_m, true, null::int from osm
    union all select ref, name, category, address, lat, lon, distance_m, true, null::int from live
  ),
  fsq as (
    select jsonb_build_object('source', 'fsq', 'source_id', f.source_id) as ref, f.name, f.category, f.address,
           f.lat, f.lon, public.st_distance(f.geog, (select g from here)::public.geography) as distance_m
    from dotty.fsq_places f
    where public.st_dwithin(f.geog, (select g from here)::public.geography, p_radius)
      and not exists (select 1 from own where own.source = 'fsq' and own.source_id = f.source_id)
      and not exists (select 1 from base b
                      where dotty.name_sim(b.name, f.name) > 0.4
                        and public.st_dwithin(public.st_setsrid(public.st_makepoint(b.lon, b.lat), 4326)::public.geography, f.geog, 80))
  )
  select ref, name, category, address, lat, lon, distance_m, verified, posters from base
  union all
  select ref, name, category, address, lat, lon, distance_m, true, null::int from fsq
  order by distance_m
  limit p_limit;
$function$;
revoke execute on function dotty.nearby_places(double precision, double precision, integer, integer) from public, anon;
grant execute on function dotty.nearby_places(double precision, double precision, integer, integer) to authenticated, service_role;

create function dotty.find_places(p_q text, p_lat double precision, p_lon double precision, p_radius integer default 150)
returns table(ref jsonb, name text, category text, address text, lat double precision, lon double precision, distance_m double precision, verified boolean, posters int, score real)
language sql stable security definer set search_path = ''
as $function$
  with c as (
    select n.*, dotty.name_sim(n.name, p_q) as score
    from dotty.nearby_places(p_lat, p_lon, least(greatest(p_radius, 50), 300), 3000) n
    where length(dotty.name_key(p_q)) >= 2
  )
  select ref, name, category, address, lat, lon, distance_m, verified, posters, score
  from c where score >= 0.3
  order by score desc, distance_m
  limit 10;
$function$;
revoke execute on function dotty.find_places(text, double precision, double precision, integer) from public, anon;
grant execute on function dotty.find_places(text, double precision, double precision, integer) to authenticated;

-- ── posting ──────────────────────────────────────────────────────────────────

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
  v_name    text;
  v_vis     text := p_visibility;
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
  elsif p_place->>'source' = 'user' then
    -- a suggested place: right here, checked name, one per name and spot
    v_name := dotty.clean_place_name(p_place->>'name');
    if v_name is null then raise exception 'bad_place_name' using errcode = 'P0001'; end if;
    select * into v_place from dotty.places pl
     where pl.source = 'user'
       and public.st_dwithin(pl.geog, public.st_setsrid(public.st_makepoint(p_lon, p_lat), 4326)::public.geography, 50)
       and dotty.name_sim(pl.name, v_name) > 0.6
     order by pl.verified desc, pl.created_at limit 1;
    if not found then
      if (select count(*) from dotty.places where created_by = uid and source = 'user'
            and created_at > now() - interval '1 day') >= 3 then
        raise exception 'too_many_places' using errcode = 'P0001';
      end if;
      insert into dotty.places (source, name, category, district, city, lat, lon, created_by, verified)
      values ('user', v_name, 'other', p_district, p_city, p_lat, p_lon, uid, false)
      returning * into v_place;
    end if;
  end if;

  if v_place.id is null then raise exception 'place_not_found' using errcode = 'P0002'; end if;

  v_dist := public.st_distance(
    v_place.geog,
    public.st_setsrid(public.st_makepoint(p_lon, p_lat), 4326)::public.geography
  );
  if v_dist > max_dist + least(p_accuracy, 50) then
    raise exception 'too_far' using errcode = 'P0001', detail = round(v_dist)::text;
  end if;

  -- moments at a place that's still a suggestion stay with your friends
  if not v_place.verified then v_vis := 'friends'; end if;

  if v_place.district is null and p_district is not null then
    update dotty.places set district = p_district, city = coalesce(city, p_city)
     where id = v_place.id returning * into v_place;
  end if;

  insert into dotty.moments (user_id, place_id, caption, photo_path, visibility, lat, lon, accuracy_m)
  values (uid, v_place.id, nullif(trim(p_caption), ''), p_photo_path, v_vis, p_lat, p_lon, p_accuracy)
  returning * into v_moment;

  -- the third different person confirms a suggestion
  if not v_place.verified then perform dotty.verify_suggested_places(v_place.id); end if;

  insert into dotty.notifications (recipient_id, actor_id, type, moment_id, place_id)
  select fid, uid, 'here', v_moment.id, v_place.id from dotty.friend_ids(uid) fid;

  return v_moment;
end;
$function$;
