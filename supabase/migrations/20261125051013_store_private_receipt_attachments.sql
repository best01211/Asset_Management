insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('purchase-receipts','purchase-receipts',false,4194304,array['image/jpeg','image/png','application/pdf'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,
 allowed_mime_types=excluded.allowed_mime_types;

create policy purchase_attachment_read on storage.objects for select to authenticated using (
 bucket_id='purchase-receipts' and split_part(name,'/',1)=(select auth.uid())::text
 and exists(
  select 1 from public.pending_transactions p
  where p.user_id=(select auth.uid()) and p.id::text=split_part(name,'/',2)
 )
);
create policy purchase_attachment_insert on storage.objects for insert to authenticated with check (
 bucket_id='purchase-receipts' and split_part(name,'/',1)=(select auth.uid())::text
 and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|pdf)$'
 and exists(
  select 1 from public.pending_transactions p
  where p.user_id=(select auth.uid()) and p.id::text=split_part(name,'/',2)
   and p.status in ('pending_review','confirmed')
 )
);
