begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','12345678-0000-4000-8000-000000000041',true);
do $$
declare
 id uuid;
 bank uuid;
 meals uuid;
 tx uuid;
 saved jsonb;
begin
 bank := public.create_krw_payment_account('Annotation bank','asset');
 meals := public.create_krw_expense_category('Annotation meals');
 id := public.create_pending_expense('Annotation purchase',4000,'2024-01-04T08:00:00+09:00','cash',bank,meals);
 tx := (public.approve_pending_expense(id,1,gen_random_uuid())->>'transaction_id')::uuid;
 saved := public.save_transaction_annotation(tx,0,'First note',array['work']);
 if saved->>'version'<>'1' or saved->>'memo'<>'First note' then raise exception 'annotation save failed'; end if;
 begin
  perform public.save_transaction_annotation(tx,0,'Stale',array[]::text[]);
  raise exception 'stale version accepted';
 exception when unique_violation then null;
 end;
 saved := public.save_transaction_annotation(tx,1,'Updated',array['finance','work']);
 if saved->>'version'<>'2' or (select amount_minor from public.transactions where public.transactions.id=tx)<>4000 then
  raise exception 'annotation version or ledger total changed';
 end if;
 if (select count(*) from public.audit_logs where entity_id=tx and action='transaction_annotation_saved')<>2 then
  raise exception 'annotation audit entries missing';
 end if;
 begin
  update public.transaction_annotations set memo='direct write' where transaction_id=tx;
  raise exception 'direct write accepted';
 exception when insufficient_privilege then null;
 end;
 perform set_config('request.jwt.claim.sub','12345678-0000-4000-8000-000000000042',true);
 if exists(select 1 from public.transaction_annotations where transaction_id=tx) then
  raise exception 'other user read annotation';
 end if;
 begin
  perform public.save_transaction_annotation(tx,2,'Foreign user',array[]::text[]);
  raise exception 'foreign write accepted';
 exception when no_data_found then null;
 end;
end
$$;
rollback;
