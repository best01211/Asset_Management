-- Run after all migrations in an isolated local database. No fixtures are retained.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','ffffffff-ffff-4fff-8fff-ffffffffffff',true);

do $$
declare
 uid uuid := auth.uid();
 asset_id uuid;
 expense_id uuid;
 category uuid;
 draft uuid;
 tx uuid;
 key uuid := gen_random_uuid();
begin
 insert into public.financial_accounts(user_id,name,kind)
 values(uid,'Test cash','asset') returning id into asset_id;
 insert into public.financial_accounts(user_id,name,kind)
 values(uid,'Test expenses','expense') returning id into expense_id;

 begin
  insert into public.categories(user_id,name,expense_account_id) values(uid,'Invalid',asset_id);
  raise exception 'EXPECTED_EXPENSE_ACCOUNT_CONSTRAINT';
 exception when foreign_key_violation then
  if sqlerrm not like '%category_expense_account_kind_fk%' then raise; end if;
 end;

 insert into public.categories(user_id,name,expense_account_id)
 values(uid,'Test category',expense_id) returning id into category;
 draft := public.create_pending_expense('Test purchase',5500,now(),'cash',asset_id,category);
 tx := (public.approve_pending_expense(draft,1,key)->>'transaction_id')::uuid;

 begin
  update public.ledger_entries set amount_minor=1 where transaction_id=tx;
  raise exception 'EXPECTED_DIRECT_LEDGER_WRITE_REJECTION';
 exception when insufficient_privilege then null;
 end;
end
$$;

set constraints all immediate;
select set_config('request.jwt.claim.sub','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',true);
do $$
declare owner_id constant uuid := 'ffffffff-ffff-4fff-8fff-ffffffffffff';
begin
 if exists (select 1 from public.transactions where user_id=owner_id)
 or exists (select 1 from public.ledger_entries where user_id=owner_id)
 or exists (select 1 from public.transaction_splits where user_id=owner_id)
 or exists (select 1 from public.pending_transactions where user_id=owner_id) then
  raise exception 'CROSS_USER_POSTING_VISIBLE';
 end if;
end
$$;
reset role;

do $$
declare
 posted record;
 target text;
 draft uuid;
begin
 select * into strict posted from public.transactions
 where user_id='ffffffff-ffff-4fff-8fff-ffffffffffff';

 foreach target in array array['transactions','ledger_entries','transaction_splits','pending_transactions'] loop
  begin
   execute format('delete from public.%I where user_id = $1',target) using posted.user_id;
   raise exception 'EXPECTED_DELETE_REJECTION: %',target;
  exception when sqlstate '55000' then
   if sqlerrm <> 'CONFIRMED_LEDGER_IMMUTABLE' then raise; end if;
  end;
 end loop;

 begin
  update public.ledger_entries set amount_minor=1 where transaction_id=posted.id;
  raise exception 'EXPECTED_UPDATE_REJECTION';
 exception when sqlstate '55000' then
  if sqlerrm <> 'CONFIRMED_LEDGER_IMMUTABLE' then raise; end if;
 end;

 begin
  insert into public.ledger_entries(user_id,transaction_id,account_id,side,amount_minor,currency)
  select user_id,transaction_id,account_id,side,amount_minor,currency
  from public.ledger_entries where transaction_id=posted.id;
  raise exception 'EXPECTED_APPEND_REJECTION';
 exception when sqlstate '55000' then
  if sqlerrm <> 'CONFIRMED_LEDGER_IMMUTABLE' then raise; end if;
 end;

 insert into public.pending_transactions(user_id,merchant,amount_minor,occurred_at,payment_method,payment_account_id,category_id)
 select user_id,'Unposted test',amount_minor,occurred_at,payment_method,payment_account_id,category_id
 from public.pending_transactions where id=posted.source_pending_id returning id into draft;

 begin
  insert into public.transactions(user_id,source_pending_id,kind,amount_minor,currency,merchant,occurred_at)
  values(posted.user_id,draft,posted.kind,posted.amount_minor,posted.currency,posted.merchant,posted.occurred_at);
  raise exception 'EXPECTED_EMPTY_LEDGER_REJECTION';
 exception when check_violation then
  if sqlerrm <> 'LEDGER_UNBALANCED' then raise; end if;
 end;
end
$$;
rollback;

-- Force an error at the final write of approval. The full operation should roll back.
begin;
create function pg_temp.reject_test_audit() returns trigger
language plpgsql as $$
begin
 raise exception 'TEST_AUDIT_FAILURE' using errcode='23514';
end;
$$;

create trigger reject_test_audit before insert on public.audit_logs
 for each row execute function pg_temp.reject_test_audit();

set local role authenticated;
select set_config('request.jwt.claim.sub','ffffffff-ffff-4fff-8fff-ffffffffffff',true);

do $$
declare
 uid uuid := auth.uid();
 asset_id uuid;
 expense_id uuid;
 category uuid;
 draft uuid;
 key uuid := gen_random_uuid();
begin
 insert into public.financial_accounts(user_id,name,kind)
 values(uid,'Test cash','asset') returning id into asset_id;
 insert into public.financial_accounts(user_id,name,kind)
 values(uid,'Test expenses','expense') returning id into expense_id;
 insert into public.categories(user_id,name,expense_account_id)
 values(uid,'Test category',expense_id) returning id into category;
 draft := public.create_pending_expense('Rollback purchase',5500,now(),'cash',asset_id,category);

 begin
  perform public.approve_pending_expense(draft,1,key);
  raise exception 'EXPECTED_APPROVAL_FAILURE';
 exception when check_violation then
  if sqlerrm <> 'TEST_AUDIT_FAILURE' then raise; end if;
 end;

 if not exists (
  select 1 from public.pending_transactions where id=draft
  and status='pending_review' and version=1 and confirmed_transaction_id is null
 ) or exists (select 1 from public.transactions where source_pending_id=draft)
 or exists (select 1 from public.ledger_entries where user_id=uid)
 or exists (select 1 from public.transaction_splits where user_id=uid)
 or exists (select 1 from public.audit_logs where entity_id=draft) then
  raise exception 'PARTIAL_APPROVAL_RETAINED';
 end if;
end
$$;

reset role;
do $$
begin
 if exists (select 1 from public.approval_requests where user_id='ffffffff-ffff-4fff-8fff-ffffffffffff')
 then raise exception 'FAILED_APPROVAL_KEY_RETAINED'; end if;
 if has_function_privilege('anon','public.approve_pending_expense(uuid,integer,uuid)','EXECUTE')
 then raise exception 'ANONYMOUS_APPROVAL_ALLOWED'; end if;
end
$$;
rollback;
