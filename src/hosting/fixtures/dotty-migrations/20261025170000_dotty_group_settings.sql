-- Group chat settings: rename, see members, add friends, remove (creator), leave.

create or replace function dotty.group_members(p_chat uuid)
returns table (user_id uuid, username text, avatar_path text, is_creator boolean, is_me boolean)
language sql stable security definer set search_path = ''
as $$
  select p.id, p.username, p.avatar_path, p.id = c.created_by, p.id = auth.uid()
  from dotty.chats c
  join dotty.chat_members cm on cm.chat_id = c.id
  join dotty.profiles p on p.id = cm.user_id
  where c.id = p_chat and c.kind = 'group' and dotty.is_chat_member(p_chat)
  order by (p.id = auth.uid()) desc, (p.id = c.created_by) desc, p.username;
$$;

create or replace function dotty.rename_group_chat(p_chat uuid, p_title text)
returns void language plpgsql security definer set search_path = ''
as $$
declare t text := left(btrim(p_title), 60);
begin
  if not dotty.is_chat_member(p_chat) then raise exception 'not_member'; end if;
  if t is null or t = '' then raise exception 'bad_title'; end if;
  update dotty.chats set title = t where id = p_chat and kind = 'group';
end;
$$;

-- any member can add their own friends
create or replace function dotty.add_group_members(p_chat uuid, p_users uuid[])
returns void language plpgsql security definer set search_path = ''
as $$
declare me uuid := auth.uid(); u uuid;
begin
  if not exists (select 1 from dotty.chats where id = p_chat and kind = 'group') or not dotty.is_chat_member(p_chat) then
    raise exception 'not_member';
  end if;
  foreach u in array coalesce(p_users, '{}') loop
    if not dotty.are_friends(me, u) then raise exception 'not_friends'; end if;
    insert into dotty.chat_members (chat_id, user_id) values (p_chat, u) on conflict do nothing;
  end loop;
end;
$$;

-- the creator can remove others; everyone can remove themselves (= leave)
create or replace function dotty.remove_group_member(p_chat uuid, p_user uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare me uuid := auth.uid(); v_creator uuid; v_next uuid;
begin
  select created_by into v_creator from dotty.chats where id = p_chat and kind = 'group';
  if not found or not dotty.is_chat_member(p_chat) then raise exception 'not_member'; end if;
  if p_user <> me and v_creator is distinct from me then raise exception 'not_allowed'; end if;

  delete from dotty.chat_members where chat_id = p_chat and user_id = p_user;

  if not exists (select 1 from dotty.chat_members where chat_id = p_chat) then
    delete from dotty.chats where id = p_chat;            -- last one out
  elsif p_user = v_creator then                            -- hand the group to the longest member
    select user_id into v_next from dotty.chat_members where chat_id = p_chat order by joined_at limit 1;
    update dotty.chats set created_by = v_next where id = p_chat;
  end if;
end;
$$;

revoke execute on function dotty.group_members(uuid), dotty.rename_group_chat(uuid, text),
  dotty.add_group_members(uuid, uuid[]), dotty.remove_group_member(uuid, uuid) from public, anon;
grant execute on function dotty.group_members(uuid), dotty.rename_group_chat(uuid, text),
  dotty.add_group_members(uuid, uuid[]), dotty.remove_group_member(uuid, uuid) to authenticated;
