-- Blocking and reporting people.
-- A block works both ways: neither sees the other's moments or comments, the
-- friendship ends, no new friend requests and no direct messages.

create table dotty.blocks (
  blocker_id uuid not null default auth.uid() references dotty.profiles (id) on delete cascade,
  blocked_id uuid not null references dotty.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index blocks_blocked_idx on dotty.blocks (blocked_id);
alter table dotty.blocks enable row level security;
-- you only ever see your own blocks (not who blocked you)
create policy blocks_read on dotty.blocks for select to authenticated using (blocker_id = (select auth.uid()));
create policy blocks_remove on dotty.blocks for delete to authenticated using (blocker_id = (select auth.uid()));
revoke all on dotty.blocks from anon, authenticated;
grant select, delete on dotty.blocks to authenticated;

create or replace function dotty.is_blocked(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from dotty.blocks
    where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a)
  );
$$;
revoke execute on function dotty.is_blocked(uuid, uuid) from public, anon;
grant execute on function dotty.is_blocked(uuid, uuid) to authenticated;

create or replace function dotty.block_user(p_user uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not_signed_in'; end if;
  if p_user = me then raise exception 'cannot_block_self'; end if;
  insert into dotty.blocks (blocker_id, blocked_id) values (me, p_user) on conflict do nothing;
  delete from dotty.friendships
   where (requester = me and addressee = p_user) or (requester = p_user and addressee = me);
end;
$$;
revoke execute on function dotty.block_user(uuid) from public, anon;
grant execute on function dotty.block_user(uuid) to authenticated;

-- moments: hidden both ways once blocked
create or replace function dotty.can_see_moment(m_user uuid, m_visibility text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select m_user = auth.uid()
      or (not dotty.is_blocked(auth.uid(), m_user)
          and (m_visibility = 'public' or dotty.are_friends(auth.uid(), m_user)));
$$;

-- comments from / to blocked people disappear
drop policy comments_read on dotty.comments;
create policy comments_read on dotty.comments for select to authenticated using (
  exists (select 1 from dotty.moments m where m.id = comments.moment_id)
  and (user_id = (select auth.uid()) or not dotty.is_blocked((select auth.uid()), user_id))
);
drop policy comments_insert on dotty.comments;
create policy comments_insert on dotty.comments for insert to authenticated with check (
  user_id = (select auth.uid())
  and exists (select 1 from dotty.moments m where m.id = comments.moment_id)
);

-- no friend requests between blocked people
drop policy friendships_request on dotty.friendships;
create policy friendships_request on dotty.friendships for insert to authenticated with check (
  requester = (select auth.uid()) and status = 'pending' and not dotty.is_blocked(requester, addressee)
);

-- no messages in a direct chat with someone you blocked / who blocked you
create or replace function dotty.chat_blocked(p_chat uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from dotty.chats c
    join dotty.chat_members o on o.chat_id = c.id and o.user_id <> auth.uid()
    where c.id = p_chat and c.kind = 'direct' and dotty.is_blocked(auth.uid(), o.user_id)
  );
$$;
revoke execute on function dotty.chat_blocked(uuid) from public, anon;
grant execute on function dotty.chat_blocked(uuid) to authenticated;
drop policy messages_insert on dotty.messages;
create policy messages_insert on dotty.messages for insert to authenticated with check (
  user_id = (select auth.uid()) and dotty.is_chat_member(chat_id) and not dotty.chat_blocked(chat_id)
);

create or replace function dotty.start_direct_chat(p_other uuid)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare me uuid := auth.uid(); k text; cid uuid;
begin
  if me is null then raise exception 'not_signed_in'; end if;
  if dotty.is_blocked(me, p_other) then raise exception 'blocked'; end if;
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

-- reporting a person (not just a moment)
create table dotty.user_reports (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references dotty.profiles (id) on delete cascade,
  reporter_id uuid not null default auth.uid() references dotty.profiles (id) on delete cascade,
  reason      text not null check (reason in ('spam', 'inappropriate', 'harassment', 'fake', 'other')),
  created_at  timestamptz not null default now(),
  unique (user_id, reporter_id)
);
create index user_reports_user_idx on dotty.user_reports (user_id);
alter table dotty.user_reports enable row level security;
create policy user_reports_insert on dotty.user_reports for insert to authenticated
  with check (reporter_id = (select auth.uid()) and user_id <> (select auth.uid()));
revoke all on dotty.user_reports from anon, authenticated;
grant insert (user_id, reason) on dotty.user_reports to authenticated;
grant all on dotty.blocks, dotty.user_reports to service_role;
