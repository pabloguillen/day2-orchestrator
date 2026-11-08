-- Comments on moments.
-- You can read and write comments exactly on the moments you can see (RLS on
-- dotty.moments applies inside the policies). Authors delete their own
-- comments; the moment's owner can delete any comment on it.

create table dotty.comments (
  id          uuid primary key default gen_random_uuid(),
  moment_id   uuid not null references dotty.moments (id) on delete cascade,
  user_id     uuid not null default auth.uid() references dotty.profiles (id) on delete cascade,
  body        text not null check (char_length(btrim(body)) between 1 and 500),
  created_at  timestamptz not null default now()
);
create index comments_moment_idx on dotty.comments (moment_id, created_at);
create index comments_user_idx on dotty.comments (user_id);

alter table dotty.comments enable row level security;

create policy comments_read on dotty.comments for select to authenticated
  using (exists (select 1 from dotty.moments m where m.id = moment_id));

create policy comments_insert on dotty.comments for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from dotty.moments m where m.id = moment_id)
  );

create policy comments_delete on dotty.comments for delete to authenticated
  using (
    user_id = (select auth.uid())
    or exists (select 1 from dotty.moments m where m.id = moment_id and m.user_id = (select auth.uid()))
  );

revoke all on dotty.comments from anon, authenticated;
grant select, delete on dotty.comments to authenticated;
grant insert (moment_id, body) on dotty.comments to authenticated;

-- comments with the author's profile
create view dotty.comment_cards with (security_invoker = true) as
select c.id, c.moment_id, c.user_id, c.body, c.created_at,
       p.username, p.avatar_path
from dotty.comments c
join dotty.profiles p on p.id = c.user_id;
revoke all on dotty.comment_cards from anon;
grant select on dotty.comment_cards to authenticated;

-- comment count on every moment card (appended column)
create or replace view dotty.moment_cards with (security_invoker = true) as
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
  end as relation,
  (select count(*) from dotty.comments c where c.moment_id = m.id)::int as comment_count
from dotty.moments m
join dotty.profiles p on p.id = m.user_id
join dotty.places pl on pl.id = m.place_id;

-- notifications: new type 'comment', pointing at the comment
alter table dotty.notifications drop constraint notifications_type_check;
alter table dotty.notifications add constraint notifications_type_check
  check (type in ('here', 'reaction', 'friend_request', 'friend_accepted', 'comment'));
alter table dotty.notifications add column comment_id uuid references dotty.comments (id) on delete cascade;
create index notifications_comment_idx on dotty.notifications (comment_id);

-- notify the moment's owner and everyone else who commented on it before
-- (people who can still see the moment), never the commenter themself
create or replace function dotty.on_comment()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_owner uuid; v_place uuid; v_vis text;
begin
  select user_id, place_id, visibility into v_owner, v_place, v_vis from dotty.moments where id = new.moment_id;
  if v_owner is null then return new; end if;

  insert into dotty.notifications (recipient_id, actor_id, type, moment_id, place_id, comment_id)
  select r.id, new.user_id, 'comment', new.moment_id, v_place, new.id
  from (
    select v_owner as id
    union
    select c.user_id from dotty.comments c
    where c.moment_id = new.moment_id and c.id <> new.id
  ) r
  where r.id <> new.user_id
    and (
      r.id = v_owner
      or v_vis = 'public'
      or exists (
        select 1 from dotty.friendships f
        where f.status = 'accepted'
          and ((f.requester = r.id and f.addressee = v_owner) or (f.requester = v_owner and f.addressee = r.id))
      )
    );
  return new;
end;
$$;
revoke execute on function dotty.on_comment() from public, anon, authenticated;
create trigger comment_insert after insert on dotty.comments
  for each row execute function dotty.on_comment();
