begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','14141414-1414-4141-8141-111111111111',true);
do $$
declare
 uid uuid := auth.uid();
 account_id uuid;
 category_id uuid;
 pending_id uuid;
 request_key uuid := gen_random_uuid();
 when_value timestamptz := '2024-06-01T00:00:00Z';
 receipt jsonb;
begin
 account_id := public.create_krw_payment_account('Connected bank','asset');
 category_id := public.create_krw_expense_category('Connected meals');
 if public.create_krw_payment_account(' CONNECTED BANK ','asset') is distinct from account_id
  or public.create_krw_expense_category(' connected meals ') is distinct from category_id
  or (select count(*) from public.financial_accounts where user_id=uid)<>2 then
  raise exception 'SETUP_CREATED_DUPLICATES';
 end if;

 receipt := public.create_manual_pending_expense('Manual purchase',5000,when_value,'cash',account_id,category_id,request_key);
 pending_id := (receipt->>'pending_transaction_id')::uuid;
 if pending_id is null or receipt->>'replayed' is distinct from 'false'
  or exists(select 1 from public.transactions where source_pending_id=pending_id) then raise exception 'MANUAL_CREATION_INVALID'; end if;
 perform public.edit_pending_expense(pending_id,1,'Corrected purchase','6000',when_value,'cash',account_id,category_id);
 receipt := public.create_manual_pending_expense('Manual purchase',5000,when_value,'cash',account_id,category_id,request_key);
 if receipt->>'pending_transaction_id' is distinct from pending_id::text
  or receipt->>'replayed' is distinct from 'true'
  or not exists(select 1 from public.pending_transactions where id=pending_id and version=2 and amount_minor=6000)
 then raise exception 'MANUAL_RETRY_LOST_EDIT'; end if;
 begin
  perform public.create_manual_pending_expense('Manual purchase',6000,when_value,'cash',account_id,category_id,request_key);
  raise exception 'EXPECTED_MANUAL_REQUEST_CONFLICT';
 exception when unique_violation then
  if sqlerrm <> 'MANUAL_REQUEST_CONFLICT' then raise; end if;
 end;
 perform public.approve_pending_expense(pending_id,2,gen_random_uuid());
 receipt := public.create_manual_pending_expense('Manual purchase',5000,when_value,'cash',account_id,category_id,request_key);
 if receipt->>'status' is distinct from 'confirmed' then raise exception 'REPLAYED_STATUS_OUTDATED'; end if;

 perform set_config('request.jwt.claim.sub','14141414-1414-4141-8141-222222222222',true);
 if public.create_krw_expense_category('Connected meals') is not distinct from category_id
  or public.create_krw_payment_account('Connected bank','asset') is not distinct from account_id
 then raise exception 'SETUP_SHARED_BETWEEN_USERS'; end if;
end
$$;
set constraints all immediate;
rollback;
