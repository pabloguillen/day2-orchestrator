-- Making sure places are real.
--
-- 1. OSM places can only be picked from the imported OpenStreetMap data (unchanged).
-- 2. "Genau hier" places (source 'user') can no longer carry a made-up name:
--    every new one is checked against Mapbox by the verify-place function
--    (trigger below) and renamed to what is really at that spot if needed.
--    They are always category 'area', a nearby one with the same name is
--    reused instead of creating duplicates, and you can create at most 5 a day.
-- 3. Teleporting is refused: a moment more than 1000 km/h away from your
--    previous one (faster than a plane) fails with location_implausible.
-- 4. Moments can be reported with the reason "wrong_place".

alter table dotty.places add column if not exists checked_at timestamptz;
alter table dotty.places add column if not exists renamed_from text;
update dotty.places set checked_at = coalesce(checked_at, created_at) where source = 'osm';

-- ── check new user places ────────────────────────────────────────────────────

create or replace function dotty.on_user_place()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_url text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'dotty_functions_url';
  if v_url is null then return new; end if;
  perform net.http_post(
    url     := v_url || '/verify-place',
    body    := jsonb_build_object('place_id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json')
  );
  return new;
end;
$$;

drop trigger if exists user_place_check on dotty.places;
create trigger user_place_check after insert on dotty.places
  for each row when (new.source = 'user') execute function dotty.on_user_place();

-- retry anything the geocoder missed (and check the places from before this existed)
create or replace function dotty.recheck_user_places()
returns int language plpgsql security definer set search_path = ''
as $$
declare v_url text; n int := 0; r record;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'dotty_functions_url';
  if v_url is null then return 0; end if;
  for r in select id from dotty.places
           where source = 'user' and checked_at is null and created_at < now() - interval '2 minutes'
           limit 200 loop
    perform net.http_post(url := v_url || '/verify-place', body := jsonb_build_object('place_id', r.id),
                          headers := jsonb_build_object('Content-Type', 'application/json'));
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function dotty.recheck_user_places() from public, anon, authenticated;
select cron.schedule('dotty-recheck-places', '7 * * * *', 'select dotty.recheck_user_places()');

-- ── reports: "the place is wrong" ───────────────────────────────────────────

alter table dotty.reports drop constraint if exists reports_reason_check;
alter table dotty.reports add constraint reports_reason_check
  check (reason in ('spam', 'inappropriate', 'harassment', 'wrong_place', 'other'));

-- ── posting ──────────────────────────────────────────────────────────────────

create or replace function dotty.post_moment(p_place jsonb, p_caption text, p_photo_path text, p_visibility text, p_lat double precision, p_lon double precision, p_accuracy double precision, p_district text default null, p_city text default null)
returns dotty.moments
language plpgsql security definer set search_path = ''
as $function$
declare
  uid       uuid := auth.uid();
  v_place   dotty.places;
  v_osm     record;
  v_dist    double precision;
  v_moment  dotty.moments;
  v_prev    record;
  v_name    text;
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
  elsif p_place->>'source' = 'user' then
    -- the name must look like a place name; whatever it says, verify-place
    -- checks it against Mapbox right after and corrects it if it's made up
    v_name := left(regexp_replace(btrim(coalesce(p_place->>'name', '')), '\s+', ' ', 'g'), 60);
    if v_name !~ '[[:alpha:]]' or v_name ~* '(https?:|www\.|@|\.com|\.de\b)' then
      v_name := coalesce(nullif(p_district, ''), nullif(p_city, ''), 'Unterwegs');
    end if;
    -- reuse a nearby one instead of piling up duplicates
    select * into v_place from dotty.places pl
     where pl.source = 'user' and lower(pl.name) = lower(v_name)
       and public.st_dwithin(pl.geog, public.st_setsrid(public.st_makepoint(p_lon, p_lat), 4326)::public.geography, 75)
     order by pl.created_at limit 1;
    if not found then
      if (select count(*) from dotty.places where created_by = uid and created_at > now() - interval '1 day') >= 5 then
        raise exception 'too_many_places' using errcode = 'P0001';
      end if;
      insert into dotty.places (source, name, category, district, city, lat, lon, created_by)
      values ('user', v_name, 'area', p_district, p_city, p_lat, p_lon, uid)
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
