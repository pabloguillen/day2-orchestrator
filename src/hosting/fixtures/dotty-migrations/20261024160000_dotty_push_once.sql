-- Each notification is pushed at most once; the push function claims it via pushed_at.
-- That makes the function safe to call without a shared secret (replays do nothing).
alter table dotty.notifications add column pushed_at timestamptz;

create or replace function dotty.on_notification()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_url text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'dotty_functions_url';
  if v_url is null then return new; end if;
  perform net.http_post(
    url     := v_url || '/push',
    body    := jsonb_build_object('notification_id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json')
  );
  return new;
end;
$$;
revoke execute on function dotty.on_notification() from public, anon, authenticated;

select vault.create_secret('https://xpmsqdipsphzeytmaypf.supabase.co/functions/v1', 'dotty_functions_url', 'Base URL for Dotty edge functions (push trigger)');
