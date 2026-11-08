-- Chats: 1:1 with a friend, groups of friends, and one open room per city
-- ("Berlin") for everyone who is there right now.

create table dotty.chats (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('direct', 'group', 'city')),
  title           text check (title is null or char_length(title) between 1 and 60),
  city            text unique,                      -- only for kind = 'city'
  direct_key      text unique,                      -- 'uuidA:uuidB' (sorted) for kind = 'direct'
  created_by      uuid references dotty.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz,
  check ((kind = 'city') = (city is not null)),
  check ((kind = 'direct') = (direct_key is not null))
);

create table dotty.chat_members (
  chat_id      uuid not null references dotty.chats (id) on delete cascade,
  user_id      uuid not null references dotty.profiles (id) on delete cascade,
  joined_at    timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),  -- city rooms: when you were last there
  last_read_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);
create index chat_members_user_idx on dotty.chat_members (user_id);

create table dotty.messages (
  id         uuid primary key default gen_random_uuid(),
  chat_id    uuid not null references dotty.chats (id) on delete cascade,
  user_id    uuid not null default auth.uid() references dotty.profiles (id) on delete cascade,
  body       text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index messages_chat_idx on dotty.messages (chat_id, created_at desc);

-- how long a city room stays writable after you were last seen in that city
create or replace function dotty.city_window() returns interval language sql immutable set search_path = '' as $$ select interval '6 hours' $$;

create or replace function dotty.is_chat_member(p_chat uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from dotty.chat_members cm join dotty.chats c on c.id = cm.chat_id
    where cm.chat_id = p_chat and cm.user_id = auth.uid()
      and (c.kind <> 'city' or cm.last_seen_at > now() - dotty.city_window())
  );
$$;

alter table dotty.chats enable row level security;
alter table dotty.chat_members enable row level security;
alter table dotty.messages enable row level security;

create policy chats_read on dotty.chats for select to authenticated using (dotty.is_chat_member(id));
create policy chat_members_read on dotty.chat_members for select to authenticated using (dotty.is_chat_member(chat_id));
create policy chat_members_mark_read on dotty.chat_members for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy messages_read on dotty.messages for select to authenticated using (dotty.is_chat_member(chat_id));
create policy messages_insert on dotty.messages for insert to authenticated
  with check (user_id = (select auth.uid()) and dotty.is_chat_member(chat_id));
create policy messages_delete on dotty.messages for delete to authenticated using (user_id = (select auth.uid()));

revoke all on dotty.chats, dotty.chat_members, dotty.messages from anon, authenticated;
grant select on dotty.chats, dotty.chat_members, dotty.messages to authenticated;
grant update (last_read_at) on dotty.chat_members to authenticated;
grant insert (chat_id, body) on dotty.messages to authenticated;
grant delete on dotty.messages to authenticated;

-- keep chats.last_message_at fresh
create or replace function dotty.on_message()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_kind text;
begin
  update dotty.chats set last_message_at = new.created_at where id = new.chat_id returning kind into v_kind;
  update dotty.chat_members set last_read_at = new.created_at where chat_id = new.chat_id and user_id = new.user_id;
  -- push to the other members of direct and group chats (city rooms stay quiet)
  if v_kind in ('direct', 'group') then
    insert into dotty.notifications (recipient_id, actor_id, type, chat_id, message_id)
    select cm.user_id, new.user_id, 'message', new.chat_id, new.id
    from dotty.chat_members cm where cm.chat_id = new.chat_id and cm.user_id <> new.user_id;
  end if;
  return new;
end;
$$;
revoke execute on function dotty.on_message() from public, anon, authenticated;
create trigger message_insert after insert on dotty.messages for each row execute function dotty.on_message();

-- notifications: chat messages (pushed, but not shown in Aktivität)
alter table dotty.notifications drop constraint notifications_type_check;
alter table dotty.notifications add constraint notifications_type_check
  check (type in ('here', 'reaction', 'friend_request', 'friend_accepted', 'comment', 'message'));
alter table dotty.notifications add column chat_id uuid references dotty.chats (id) on delete cascade;
alter table dotty.notifications add column message_id uuid references dotty.messages (id) on delete cascade;
create index notifications_chat_idx on dotty.notifications (chat_id);
create index notifications_message_idx on dotty.notifications (message_id);

-- ── RPCs ──────────────────────────────────────────────────────────────────────

-- open (or create) the 1:1 chat with a friend
create or replace function dotty.start_direct_chat(p_other uuid)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare me uuid := auth.uid(); k text; cid uuid;
begin
  if me is null then raise exception 'not_signed_in'; end if;
  if not dotty.are_friends(me, p_other) then raise exception 'not_friends'; end if;
  k := least(me::text, p_other::text) || ':' || greatest(me::text, p_other::text);
  select id into cid from dotty.chats where direct_key = k;
  if cid is null then
    insert into dotty.chats (kind, direct_key, created_by) values ('direct', k, me) returning id into cid;
    insert into dotty.chat_members (chat_id, user_id) values (cid, me), (cid, p_other);
  end if;
  return cid;
end;
$$;

-- a group with some of your friends
create or replace function dotty.create_group_chat(p_title text, p_members uuid[])
returns uuid language plpgsql security definer set search_path = ''
as $$
declare me uuid := auth.uid(); cid uuid; m uuid;
begin
  if me is null then raise exception 'not_signed_in'; end if;
  if coalesce(array_length(p_members, 1), 0) < 2 then raise exception 'group_too_small'; end if;
  foreach m in array p_members loop
    if not dotty.are_friends(me, m) then raise exception 'not_friends'; end if;
  end loop;
  insert into dotty.chats (kind, title, created_by) values ('group', left(btrim(p_title), 60), me) returning id into cid;
  insert into dotty.chat_members (chat_id, user_id)
  select cid, u from unnest(array_append(p_members, me)) u group by u;
  return cid;
end;
$$;

-- you are in this city right now: join / refresh your seat in its room
create or replace function dotty.join_city_chat(p_city text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare me uuid := auth.uid(); c text := btrim(p_city); cid uuid;
begin
  if me is null then raise exception 'not_signed_in'; end if;
  if c is null or char_length(c) < 2 or char_length(c) > 60 then raise exception 'bad_city'; end if;
  insert into dotty.chats (kind, title, city) values ('city', c, c)
  on conflict (city) do update set city = excluded.city
  returning id into cid;
  insert into dotty.chat_members (chat_id, user_id) values (cid, me)
  on conflict (chat_id, user_id) do update set last_seen_at = now();
  return cid;
end;
$$;

-- your chats with title, last message and unread count
create or replace function dotty.my_chats()
returns table (
  chat_id uuid, kind text, title text, city text,
  other_id uuid, other_username text, other_avatar text,
  member_count int, last_body text, last_user text, last_at timestamptz, unread int
)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.kind,
         coalesce(c.title, op.username) as title,
         c.city,
         op.id, op.username, op.avatar_path,
         (select count(*)::int from dotty.chat_members x where x.chat_id = c.id
            and (c.kind <> 'city' or x.last_seen_at > now() - dotty.city_window())) as member_count,
         lm.body, lp.username, coalesce(lm.created_at, c.created_at),
         (select count(*)::int from dotty.messages u
            where u.chat_id = c.id and u.user_id <> auth.uid() and u.created_at > me.last_read_at
              and c.kind <> 'city') as unread
  from dotty.chat_members me
  join dotty.chats c on c.id = me.chat_id
  left join lateral (
    select p.id, p.username, p.avatar_path from dotty.chat_members o join dotty.profiles p on p.id = o.user_id
    where c.kind = 'direct' and o.chat_id = c.id and o.user_id <> auth.uid() limit 1
  ) op on true
  left join lateral (
    select m.body, m.user_id, m.created_at from dotty.messages m where m.chat_id = c.id order by m.created_at desc limit 1
  ) lm on true
  left join dotty.profiles lp on lp.id = lm.user_id
  where me.user_id = auth.uid()
    and (c.kind <> 'city' or me.last_seen_at > now() - dotty.city_window())
  order by coalesce(lm.created_at, c.created_at) desc;
$$;

create or replace function dotty.mark_chat_read(p_chat uuid)
returns void language sql security definer set search_path = ''
as $$
  update dotty.chat_members set last_read_at = now() where chat_id = p_chat and user_id = auth.uid();
$$;

revoke execute on function dotty.is_chat_member(uuid), dotty.start_direct_chat(uuid), dotty.create_group_chat(text, uuid[]),
  dotty.join_city_chat(text), dotty.my_chats(), dotty.mark_chat_read(uuid), dotty.city_window() from public, anon;
grant execute on function dotty.is_chat_member(uuid), dotty.start_direct_chat(uuid), dotty.create_group_chat(text, uuid[]),
  dotty.join_city_chat(text), dotty.my_chats(), dotty.mark_chat_read(uuid), dotty.city_window() to authenticated;

-- messages with author, for the chat screen
create view dotty.message_cards with (security_invoker = true) as
select m.id, m.chat_id, m.user_id, m.body, m.created_at, p.username, p.avatar_path
from dotty.messages m join dotty.profiles p on p.id = m.user_id;
revoke all on dotty.message_cards from anon;
grant select on dotty.message_cards to authenticated;

-- live updates in the app (RLS applies to realtime too)
alter publication supabase_realtime add table dotty.messages;
