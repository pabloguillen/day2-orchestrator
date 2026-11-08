-- The push Edge Function reads with the service role. Tables added after the
-- first migration had no grant for it, so message/comment pushes came without text.
grant select on dotty.messages, dotty.chats, dotty.chat_members, dotty.comments, dotty.reports, dotty.invites, dotty.settings to service_role;
alter default privileges in schema dotty grant select on tables to service_role;
