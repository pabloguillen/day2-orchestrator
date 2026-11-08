-- Invite-only sign-up, switchable from the backend.
--
--   Turn the open sign-up on:   update dotty.settings set invite_only = false;
--   …and off again:             update dotty.settings set invite_only = true;
--   A code without an inviter (e.g. for a launch event, 100 uses):
--     insert into dotty.invites (code, max_uses) values ('BERLIN', 100);
--
-- Every user has one personal code (created on first use). Joining with a
-- code makes you and the inviter friends right away.

create table dotty.settings (
  id          boolean primary key default true check (id),
  invite_only boolean not null default true,
  updated_at  timestamptz not null default now()
);
insert into dotty.settings default values;
alter table dotty.settings enable row level security; -- read only through app_config()

create table dotty.invites (
  code       text primary key check (code ~ '^[A-Z0-9]{4,16}$'),
  inviter    uuid references dotty.profiles (id) on delete cascade,
  max_uses   int check (max_uses is null or max_uses > 0),
  uses       int not null default 0,
  created_at timestamptz not null default now()
);
create unique index invites_one_per_user on dotty.invites (inviter) where inviter is not null;
alter table dotty.invites enable row level security;
create policy invites_read_own on dotty.invites for select to authenticated using (inviter = auth.uid());

alter table dotty.profiles add column if not exists invited_by uuid references dotty.profiles (id) on delete set null;

-- public: what the app needs before anyone is signed in
create or replace function dotty.app_config()
returns json language sql stable security definer set search_path = ''
as $$ select json_build_object('invite_only', s.invite_only) from dotty.settings s $$;

-- public: is this code good? (and who sent it, for "@pablo hat dich eingeladen")
create or replace function dotty.check_invite(p_code text)
returns table (valid boolean, inviter_username text, inviter_avatar text)
language sql stable security definer set search_path = ''
as $$
  select true, p.username, p.avatar_path
  from dotty.invites i left join dotty.profiles p on p.id = i.inviter
  where i.code = upper(trim(p_code)) and (i.max_uses is null or i.uses < i.max_uses)
$$;

create or replace function dotty.new_invite_code()
returns text language plpgsql volatile set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; -- no 0/O, 1/I/L
  c text := '';
begin
  for i in 1..6 loop
    c := c || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return c;
end;
$$;

-- your personal code (created the first time you ask)
create or replace function dotty.my_invite_code()
returns text language plpgsql volatile security definer set search_path = ''
as $$
declare v text;
begin
  if not exists (select 1 from dotty.profiles where id = auth.uid()) then
    raise exception 'profile_missing';
  end if;
  select code into v from dotty.invites where inviter = auth.uid();
  while v is null loop
    begin
      insert into dotty.invites (code, inviter) values (dotty.new_invite_code(), auth.uid()) returning code into v;
    exception when unique_violation then
      select code into v from dotty.invites where inviter = auth.uid(); -- raced, or the code was taken: retry
    end;
  end loop;
  return v;
end;
$$;

-- the only way to create a profile: checks the invite while sign-up is closed
create or replace function dotty.create_profile(p_username text, p_code text default null)
returns dotty.profiles language plpgsql volatile security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  inv dotty.invites;
  me dotty.profiles;
begin
  if uid is null then raise exception 'not_signed_in'; end if;
  select * into me from dotty.profiles where id = uid;
  if found then return me; end if;

  if p_code is not null and trim(p_code) <> '' then
    select * into inv from dotty.invites
    where code = upper(trim(p_code)) and (max_uses is null or uses < max_uses)
    for update;
  end if;
  if inv.code is null and (select invite_only from dotty.settings) then
    raise exception 'invite_required';
  end if;

  insert into dotty.profiles (id, username, invited_by)
  values (uid, p_username, inv.inviter)
  returning * into me;

  if inv.code is not null then
    update dotty.invites set uses = uses + 1 where code = inv.code;
    if inv.inviter is not null then
      -- straight to friends; the inviter gets "… ist jetzt dein Freund"
      insert into dotty.friendships (requester, addressee, status, accepted_at)
      values (inv.inviter, uid, 'accepted', now())
      on conflict do nothing;
      insert into dotty.notifications (recipient_id, actor_id, type)
      values (inv.inviter, uid, 'friend_accepted');
    end if;
  end if;
  return me;
end;
$$;

-- profiles are no longer inserted directly
drop policy if exists profiles_insert on dotty.profiles;

-- accepted-on-insert friendships (from invites) are not requests
create or replace function dotty.on_friendship_change()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and new.status = 'pending' then
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

revoke execute on function dotty.app_config(), dotty.check_invite(text), dotty.new_invite_code(),
  dotty.my_invite_code(), dotty.create_profile(text, text) from public;
grant execute on function dotty.app_config(), dotty.check_invite(text) to anon, authenticated;
grant execute on function dotty.my_invite_code(), dotty.create_profile(text, text) to authenticated;
