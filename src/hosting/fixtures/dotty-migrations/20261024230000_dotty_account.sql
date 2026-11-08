-- Settings: delete your own avatar files, and delete your whole account
-- (App Store requires in-app account deletion).

create policy dotty_avatars_delete on storage.objects for delete to authenticated
  using (bucket_id = 'dotty-avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- Deletes the caller's auth user; profiles/moments/comments/friendships/
-- notifications/push tokens go with it via ON DELETE CASCADE. The app removes
-- the caller's storage files first (storage rows can't be deleted from SQL).
create or replace function dotty.delete_my_account()
returns void language plpgsql security definer set search_path = ''
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not_signed_in'; end if;
  delete from auth.users where id = uid;
end;
$$;
revoke execute on function dotty.delete_my_account() from public, anon;
grant execute on function dotty.delete_my_account() to authenticated;
