-- Dotty: "Sieh, wo deine Freunde gerade sind."
-- Everything lives in its own `dotty` schema so the legacy pintoo tables in
-- `public` stay untouched. The only legacy table Dotty reads is
-- public.places_osm (the OSM place import) for "places near me".
--
-- Core rule: you can only share a moment when you are at the place.
-- dotty.post_moment() enforces that server-side (<= 100 m + GPS slack).

create schema if not exists dotty;
grant usage on schema dotty to anon, authenticated, service_role;

create extension if not exists pg_net with schema extensions;

-- ─────────────────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────────────────

create table dotty.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  username    text not null unique
              check (username ~ '^[a-z0-9._]{3,20}$'),
  display_name text,
  avatar_path text,
  city        text,
  created_at  timestamptz not null default now()
);

create table dotty.friendships (
  requester   uuid not null references dotty.profiles (id) on delete cascade,
  addressee   uuid not null references dotty.profiles (id) on delete cascade,
  status      text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (requester, addressee),
  check (requester <> addressee)
);
-- one row per pair, whoever asked first
create unique index friendships_pair_idx
  on dotty.friendships (least(requester, addressee), greatest(requester, addressee));
create index friendships_addressee_idx on dotty.friendships (addressee);

create table dotty.places (
  id          uuid primary key default gen_random_uuid(),
  source      text not null check (source in ('osm', 'user')),
  source_id   text,
  name        text not null check (char_length(name) between 1 and 80),
  category    text not null default 'other',
  address     text,
  district    text,
  city        text,
  lat         double precision not null,
  lon         double precision not null,
  geog        public.geography(Point, 4326)
              generated always as (public.st_setsrid(public.st_makepoint(lon, lat), 4326)::public.geography) stored,
  created_by  uuid references dotty.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (source, source_id)
);
create index places_geog_idx on dotty.places using gist (geog);

create table dotty.moments (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references dotty.profiles (id) on delete cascade,
  place_id    uuid not null references dotty.places (id) on delete cascade,
  caption     text check (char_length(caption) <= 80),
  photo_path  text not null,
  visibility  text not null default 'friends' check (visibility in ('friends', 'public')),
  lat         double precision not null,
  lon         double precision not null,
  accuracy_m  real,
  created_at  timestamptz not null default now()
);
create index moments_user_idx on dotty.moments (user_id, created_at desc);
create index moments_place_idx on dotty.moments (place_id, created_at desc);
create index moments_public_idx on dotty.moments (created_at desc) where visibility = 'public';

create table dotty.reactions (
  moment_id   uuid not null references dotty.moments (id) on delete cascade,
  user_id     uuid not null references dotty.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (moment_id, user_id)
);

create table dotty.push_tokens (
  token       text primary key,
  user_id     uuid not null references dotty.profiles (id) on delete cascade,
  platform    text not null check (platform in ('ios', 'android')),
  updated_at  timestamptz not null default now()
);
create index push_tokens_user_idx on dotty.push_tokens (user_id);

create table dotty.notifications (
  id           bigint generated always as identity primary key,
  recipient_id uuid not null references dotty.profiles (id) on delete cascade,
  actor_id     uuid not null references dotty.profiles (id) on delete cascade,
  type         text not null check (type in ('here', 'reaction', 'friend_request', 'friend_accepted')),
  moment_id    uuid references dotty.moments (id) on delete cascade,
  place_id     uuid references dotty.places (id) on delete cascade,
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index notifications_recipient_idx on dotty.notifications (recipient_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- Helpers
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function dotty.are_friends(a uuid, b uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from dotty.friendships f
    where f.status = 'accepted'
      and ((f.requester = a and f.addressee = b) or (f.requester = b and f.addressee = a))
  );
$$;

create or replace function dotty.friend_ids(uid uuid)
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select case when f.requester = uid then f.addressee else f.requester end
  from dotty.friendships f
  where f.status = 'accepted' and uid in (f.requester, f.addressee);
$$;

-- "is this user my friend?" (only about yourself, unlike are_friends)
create or replace function dotty.is_my_friend(other uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select dotty.are_friends(auth.uid(), other);
$$;

create or replace function dotty.can_see_moment(m_user uuid, m_visibility text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select m_user = auth.uid()
      or m_visibility = 'public'
      or dotty.are_friends(auth.uid(), m_user);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row level security
-- ─────────────────────────────────────────────────────────────────────────────

alter table dotty.profiles      enable row level security;
alter table dotty.friendships   enable row level security;
alter table dotty.places        enable row level security;
alter table dotty.moments       enable row level security;
alter table dotty.reactions     enable row level security;
alter table dotty.push_tokens   enable row level security;
alter table dotty.notifications enable row level security;

create policy profiles_read on dotty.profiles for select to authenticated using (true);
create policy profiles_insert on dotty.profiles for insert to authenticated with check (id = auth.uid());
create policy profiles_update on dotty.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy friendships_read on dotty.friendships for select to authenticated
  using (auth.uid() in (requester, addressee));
create policy friendships_request on dotty.friendships for insert to authenticated
  with check (requester = auth.uid() and status = 'pending');
-- accepting goes through dotty.accept_friend() (no direct UPDATE)
create policy friendships_remove on dotty.friendships for delete to authenticated
  using (auth.uid() in (requester, addressee));

-- OSM places are public knowledge; a user-created place is only visible once
-- you may see a moment there (or you created it).
create policy places_read on dotty.places for select to authenticated
  using (source = 'osm' or created_by = auth.uid()
         or exists (select 1 from dotty.moments m where m.place_id = places.id));

create policy moments_read on dotty.moments for select to authenticated
  using (dotty.can_see_moment(user_id, visibility));
create policy moments_delete on dotty.moments for delete to authenticated
  using (user_id = auth.uid());
-- no insert/update policy: moments are created only through dotty.post_moment()

create policy reactions_read on dotty.reactions for select to authenticated
  using (exists (select 1 from dotty.moments m where m.id = moment_id));
create policy reactions_add on dotty.reactions for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from dotty.moments m where m.id = moment_id));
create policy reactions_remove on dotty.reactions for delete to authenticated
  using (user_id = auth.uid());

create policy push_tokens_own on dotty.push_tokens for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy notifications_read on dotty.notifications for select to authenticated
  using (recipient_id = auth.uid());
create policy notifications_mark_read on dotty.notifications for update to authenticated
  using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());

grant select, insert, update, delete on all tables in schema dotty to authenticated;
revoke update on dotty.friendships from authenticated;
revoke insert, update, delete on dotty.places, dotty.moments, dotty.notifications from authenticated;
grant delete on dotty.moments to authenticated;
grant update (read_at) on dotty.notifications to authenticated;
-- never expose who created a place
revoke select on dotty.places from authenticated;
grant select (id, source, source_id, name, category, address, district, city, lat, lon, geog) on dotty.places to authenticated;
grant all on all tables in schema dotty to service_role;
grant usage, select on all sequences in schema dotty to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Views the app reads (security_invoker: RLS of the base tables applies)
-- ─────────────────────────────────────────────────────────────────────────────

create view dotty.moment_cards with (security_invoker = true) as
select
  m.id,
  m.user_id,
  m.place_id,
  m.caption,
  m.photo_path,
  m.visibility,
  m.created_at,
  p.username,
  p.display_name,
  p.avatar_path,
  pl.name      as place_name,
  pl.category  as place_category,
  pl.district  as place_district,
  pl.city      as place_city,
  pl.lat,
  pl.lon,
  (select count(*) from dotty.reactions r where r.moment_id = m.id)::int as fire_count,
  exists (select 1 from dotty.reactions r where r.moment_id = m.id and r.user_id = auth.uid()) as i_reacted,
  case
    when m.user_id = auth.uid() then 'me'
    when dotty.is_my_friend(m.user_id) then 'friend'
    else 'other'
  end as relation
from dotty.moments m
join dotty.profiles p on p.id = m.user_id
join dotty.places pl on pl.id = m.place_id;

create view dotty.friend_list with (security_invoker = true) as
select
  case when f.requester = auth.uid() then f.addressee else f.requester end as friend_id,
  f.status,
  case when f.requester = auth.uid() then 'outgoing' else 'incoming' end as direction,
  f.created_at,
  pr.username,
  pr.display_name,
  pr.avatar_path,
  last.place_name as last_place_name,
  last.created_at as last_seen_at
from dotty.friendships f
join dotty.profiles pr
  on pr.id = case when f.requester = auth.uid() then f.addressee else f.requester end
left join lateral (
  select pl.name as place_name, m.created_at
  from dotty.moments m join dotty.places pl on pl.id = m.place_id
  where m.user_id = pr.id
  order by m.created_at desc limit 1
) last on f.status = 'accepted'
where auth.uid() in (f.requester, f.addressee);

grant select on dotty.moment_cards, dotty.friend_list to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPCs
-- ─────────────────────────────────────────────────────────────────────────────

-- Places within p_radius metres: Dotty's own places plus the legacy OSM import.
-- `ref` is what the app passes back to post_moment as p_place.
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
  )
  select ref, name, category, address, lat, lon, distance_m from own
  union all
  select ref, name, category, address, lat, lon, distance_m from osm
  order by distance_m
  limit 30;
$$;

-- Post a moment. Only works when the device is at the place.
--   p_place: {"id": uuid}                                  existing Dotty place
--            {"source":"osm","source_id": text}             place from nearby_places
--            {"source":"user","name": text,"category": text} new place right here
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

-- Moments to draw on the map inside a bounding box.
create or replace function dotty.map_moments(
  p_scope text,
  p_min_lat double precision, p_min_lon double precision,
  p_max_lat double precision, p_max_lon double precision,
  p_hours int default 24
)
returns setof dotty.moment_cards
language sql stable security invoker set search_path = ''
as $$
  select c.* from dotty.moment_cards c
  where c.lat between p_min_lat and p_max_lat
    and c.lon between p_min_lon and p_max_lon
    and c.created_at > now() - make_interval(hours => p_hours)
    and case when p_scope = 'public' then c.visibility = 'public' or c.relation = 'me'
             else c.relation in ('me', 'friend') end
  order by c.created_at desc
  limit 200;
$$;

-- "Gerade los" / "Beliebt": public places around you today.
create or replace function dotty.public_places(p_lat double precision, p_lon double precision, p_radius int default 5000)
returns table (place_id uuid, name text, category text, district text, distance_m double precision,
               moments_today int, here_now int, cover_path text)
language sql stable security definer set search_path = ''
as $$
  select pl.id, pl.name, pl.category, pl.district,
         public.st_distance(pl.geog, public.st_setsrid(public.st_makepoint(p_lon, p_lat), 4326)::public.geography),
         count(*)::int,
         count(distinct m.user_id) filter (where m.created_at > now() - interval '60 minutes')::int,
         (array_agg(m.photo_path order by m.created_at desc))[1]
  from dotty.moments m
  join dotty.places pl on pl.id = m.place_id
  where m.visibility = 'public'
    and m.created_at > (date_trunc('day', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin')
    and public.st_dwithin(pl.geog, public.st_setsrid(public.st_makepoint(p_lon, p_lat), 4326)::public.geography, p_radius)
  group by pl.id
  order by 7 desc, 6 desc
  limit 40;
$$;

create or replace function dotty.place_stats(p_place_id uuid)
returns table (moments_total int, friends_been int, mine int)
language sql stable security definer set search_path = ''
as $$
  select
    count(*) filter (where dotty.can_see_moment(m.user_id, m.visibility))::int,
    count(distinct m.user_id) filter (where dotty.are_friends(auth.uid(), m.user_id))::int,
    count(*) filter (where m.user_id = auth.uid())::int
  from dotty.moments m where m.place_id = p_place_id;
$$;

create or replace function dotty.profile_stats(p_user uuid)
returns table (moments int, friends int, places int)
language sql stable security definer set search_path = ''
as $$
  select
    (select count(*) from dotty.moments m where m.user_id = p_user
       and (p_user = auth.uid() or dotty.can_see_moment(m.user_id, m.visibility)))::int,
    case when p_user = auth.uid() or dotty.are_friends(auth.uid(), p_user)
         then (select count(*) from dotty.friend_ids(p_user))::int end,
    (select count(distinct m.place_id) from dotty.moments m where m.user_id = p_user
       and (p_user = auth.uid() or dotty.can_see_moment(m.user_id, m.visibility)))::int;
$$;

create or replace function dotty.accept_friend(p_requester uuid)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  update dotty.friendships set status = 'accepted'
   where requester = p_requester and addressee = auth.uid() and status = 'pending';
  if not found then raise exception 'request_not_found' using errcode = 'P0002'; end if;
end;
$$;

-- A device token belongs to whoever is signed in on that device right now.
create or replace function dotty.register_push_token(p_token text, p_platform text)
returns void
language sql volatile security definer set search_path = ''
as $$
  insert into dotty.push_tokens (token, user_id, platform, updated_at)
  values (p_token, auth.uid(), p_platform, now())
  on conflict (token) do update set user_id = excluded.user_id, platform = excluded.platform, updated_at = now();
$$;

revoke execute on all functions in schema dotty from public, anon, authenticated;
grant execute on all functions in schema dotty to service_role;
grant execute on function
  dotty.nearby_places(double precision, double precision, int),
  dotty.post_moment(jsonb, text, text, text, double precision, double precision, double precision, text, text),
  dotty.map_moments(text, double precision, double precision, double precision, double precision, int),
  dotty.public_places(double precision, double precision, int),
  dotty.place_stats(uuid),
  dotty.profile_stats(uuid),
  dotty.accept_friend(uuid),
  dotty.register_push_token(text, text)
to authenticated;
-- helpers used inside RLS policies / views (they run as definer, callers need EXECUTE)
grant execute on function dotty.is_my_friend(uuid), dotty.can_see_moment(uuid, text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Notification triggers
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function dotty.on_friendship_change()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from dotty.notifications n
                   where n.recipient_id = new.addressee and n.actor_id = new.requester
                     and n.type = 'friend_request' and n.created_at > now() - interval '1 day') then
      insert into dotty.notifications (recipient_id, actor_id, type)
      values (new.addressee, new.requester, 'friend_request');
    end if;
  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'accepted' then
    new.accepted_at := now();
    insert into dotty.notifications (recipient_id, actor_id, type)
    values (new.requester, new.addressee, 'friend_accepted');
  end if;
  return new;
end;
$$;
create trigger friendship_insert after insert on dotty.friendships
  for each row execute function dotty.on_friendship_change();
create trigger friendship_accept before update on dotty.friendships
  for each row execute function dotty.on_friendship_change();

create or replace function dotty.on_reaction()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare owner uuid; v_place uuid;
begin
  select user_id, place_id into owner, v_place from dotty.moments where id = new.moment_id;
  if owner is not null and owner <> new.user_id
     and not exists (select 1 from dotty.notifications n
                     where n.recipient_id = owner and n.actor_id = new.user_id
                       and n.type = 'reaction' and n.moment_id = new.moment_id) then
    insert into dotty.notifications (recipient_id, actor_id, type, moment_id, place_id)
    values (owner, new.user_id, 'reaction', new.moment_id, v_place);
  end if;
  return new;
end;
$$;
create trigger reaction_insert after insert on dotty.reactions
  for each row execute function dotty.on_reaction();

-- Every notification is pushed by the `push` Edge Function.
-- Needs two Vault secrets (see supabase/README.md):
--   dotty_functions_url  e.g. https://<ref>.supabase.co/functions/v1
--   dotty_push_secret    shared secret, also set as PUSH_WEBHOOK_SECRET on the function
create or replace function dotty.on_notification()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_url text; v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'dotty_functions_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'dotty_push_secret';
  if v_url is null or v_secret is null then return new; end if;
  perform net.http_post(
    url     := v_url || '/push',
    body    := jsonb_build_object('notification_id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-dotty-secret', v_secret)
  );
  return new;
end;
$$;
create trigger notification_push after insert on dotty.notifications
  for each row execute function dotty.on_notification();

-- ─────────────────────────────────────────────────────────────────────────────
-- Storage: moment photos (private, readable when the moment is) and avatars
-- ─────────────────────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dotty-moments', 'dotty-moments', false, 8 * 1024 * 1024, array['image/jpeg']),
       ('dotty-avatars', 'dotty-avatars', true, 2 * 1024 * 1024, array['image/jpeg'])
on conflict (id) do nothing;

create policy dotty_moments_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'dotty-moments' and (storage.foldername(name))[1] = auth.uid()::text);
create policy dotty_moments_read on storage.objects for select to authenticated
  using (
    bucket_id = 'dotty-moments' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (select 1 from dotty.moments m where m.photo_path = name)  -- RLS on moments decides
    )
  );
create policy dotty_moments_delete on storage.objects for delete to authenticated
  using (bucket_id = 'dotty-moments' and (storage.foldername(name))[1] = auth.uid()::text);

create policy dotty_avatars_write on storage.objects for insert to authenticated
  with check (bucket_id = 'dotty-avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy dotty_avatars_update on storage.objects for update to authenticated
  using (bucket_id = 'dotty-avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ─────────────────────────────────────────────────────────────────────────────
-- Let the Data API serve the dotty schema (same as Dashboard → API → Exposed schemas)
-- ─────────────────────────────────────────────────────────────────────────────
alter role authenticator set pgrst.db_schemas = 'public, graphql_public, dotty';
notify pgrst, 'reload config';
