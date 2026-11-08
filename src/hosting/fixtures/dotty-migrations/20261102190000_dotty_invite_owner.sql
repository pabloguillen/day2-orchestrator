-- Who an invite code belongs to, for a signed-in user who opens someone's invite link:
-- the app then shows that person's profile. Signed-in only (anon only gets check_invite,
-- which never reveals user ids); hidden when either side has blocked the other.
create or replace function dotty.invite_owner(p_code text)
returns uuid
language sql stable security definer set search_path = ''
as $$
  select i.inviter
  from dotty.invites i
  where i.code = upper(trim(p_code))
    and auth.uid() is not null
    and not exists (
      select 1 from dotty.blocks b
      where (b.blocker_id = auth.uid() and b.blocked_id = i.inviter)
         or (b.blocker_id = i.inviter and b.blocked_id = auth.uid())
    )
$$;
revoke all on function dotty.invite_owner(text) from public, anon;
grant execute on function dotty.invite_owner(text) to authenticated;
