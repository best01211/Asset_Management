begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','25252525-0000-4000-8000-000000000001',true);
do $$
declare
 bank uuid := public.create_krw_payment_account('Attachment bank','asset');
 category uuid := public.create_krw_expense_category('Attachment expense');
 draft uuid;
 object_name text;
begin
 draft := public.create_pending_expense('Attachment purchase',1000,'2024-01-01T09:00:00+09:00','cash',bank,category);
 object_name := auth.uid()::text||'/'||draft::text||'/25252525-0000-4000-8000-000000000011.pdf';
 insert into storage.objects(bucket_id,name) values('purchase-receipts',object_name);
 if not exists(select 1 from storage.objects where name=object_name) then raise exception 'OWNER_CANNOT_READ_ATTACHMENT'; end if;
 perform set_config('request.jwt.claim.sub','25252525-0000-4000-8000-000000000002',true);
 if exists(select 1 from storage.objects where name=object_name) then raise exception 'OTHER_USER_ATTACHMENT_VISIBLE'; end if;
 begin
  insert into storage.objects(bucket_id,name)
  values('purchase-receipts',auth.uid()::text||'/'||draft::text||'/25252525-0000-4000-8000-000000000012.pdf');
  raise exception 'EXPECTED_OTHER_USER_DRAFT_UPLOAD_REJECTED';
 exception when insufficient_privilege then
  null;
 end;
end;
$$;
rollback;
