-- Small thumbnails for the map's photo bubbles: "<photo>.jpg" gets a sibling
-- "<photo>.jpg.t.jpg" (≈120 px). Whoever may see the photo may see its thumbnail.
drop policy if exists dotty_moments_read on storage.objects;
create policy dotty_moments_read on storage.objects for select to authenticated
  using (
    bucket_id = 'dotty-moments' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (select 1 from dotty.moments m where m.photo_path = regexp_replace(objects.name, '\.t\.jpg$', ''))
    )
  );

-- photo lookups from the storage read policy (one per image request)
create index if not exists moments_photo_path_idx on dotty.moments (photo_path);
