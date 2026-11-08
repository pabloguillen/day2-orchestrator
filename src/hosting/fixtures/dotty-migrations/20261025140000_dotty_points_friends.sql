-- Friends boost the weekly ranking:
--   +50 per person who joined Dotty with your invite code this week (max 20 counted)
--   +5  per new friendship this week (max 10 counted, so unfriend/refriend can't be farmed far)
create or replace function dotty.user_points(p_user uuid, p_since timestamptz)
returns int language sql stable security definer set search_path = ''
as $$
  select
    10 * (select count(*) from dotty.moments where user_id = p_user and created_at >= p_since)::int
  + 15 * (select count(*) from (
            select place_id from dotty.moments where user_id = p_user
            group by place_id having min(created_at) >= p_since) f)::int
  + 2 * (select count(*) from dotty.reactions r join dotty.moments m on m.id = r.moment_id
          where m.user_id = p_user and r.user_id <> p_user and r.created_at >= p_since)::int
  + 2 * (select count(*) from dotty.comments c join dotty.moments m on m.id = c.moment_id
          where m.user_id = p_user and c.user_id <> p_user and c.created_at >= p_since)::int
  + 5 * least((select streak from dotty.user_streak(p_user)), 10)
  + 50 * least((select count(*) from dotty.profiles where invited_by = p_user and created_at >= p_since), 20)::int
  + 5 * least((select count(*) from dotty.friendships
               where status = 'accepted' and accepted_at >= p_since and p_user in (requester, addressee)), 10)::int;
$$;
