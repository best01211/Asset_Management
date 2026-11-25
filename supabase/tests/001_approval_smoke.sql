-- Run against isolated LOCAL Supabase DB as privileged database role.
-- In a single transaction, impersonate an authenticated JWT with a disposable UUID.
-- Expected: successful completion without errors; ROLLBACK leaves DB clean.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);

do $$
declare uid uuid := auth.uid(); pay uuid; expense uuid; category uuid; pending uuid;
        tx uuid; response jsonb; request_key uuid := '11111111-1111-4111-8111-111111111111';
        debit_sum numeric; credit_sum numeric; total int;
begin
 if uid is null then raise exception 'TEST JWT MISSING'; end if;
 insert into public.financial_accounts(user_id,name,kind) values(uid,'Test card payable','liability') returning id into pay;
 insert into public.financial_accounts(user_id,name,kind) values(uid,'Test cafe expense','expense') returning id into expense;
 insert into public.categories(user_id,name,expense_account_id)
 values(uid,'Cafe',expense) returning id into category;
 pending := public.create_pending_expense('Test cafe',5500,now(),'credit_card',pay,category,null);
 if exists(select 1 from public.transactions where user_id=uid and source_pending_id=pending) then
  raise exception 'UNAPPROVED_LEDGER_EXISTS'; end if;
 response := public.approve_pending_expense(pending,1,request_key);
 tx := (response->>'transaction_id')::uuid;
 if (response->>'status') <> 'confirmed' or (response->>'replayed')::boolean then
  raise exception 'FIRST_APPROVAL_FAILED'; end if;
 select sum(amount_minor) filter(where side='debit'),sum(amount_minor) filter(where side='credit'),count(*)
 into debit_sum,credit_sum,total from public.ledger_entries where transaction_id=tx and user_id=uid;
 if total<>2 or debit_sum<>5500 or credit_sum<>5500 then
  raise exception 'LEDGER_BAD: %,%,%',debit_sum,credit_sum,total; end if;
 response := public.approve_pending_expense(pending,1,request_key);
 if (response->>'replayed')::boolean is not true or (response->>'transaction_id')::uuid <> tx
 then raise exception 'IDEMPOTENCY_REPLAY_FAILED'; end if;
 begin
   perform public.approve_pending_expense(pending,1,gen_random_uuid());
   raise exception 'EXPECTED_STALE_REJECTION';
 exception when sqlstate 'P0001' then null;
 end;
 if (select count(*) from public.transactions where user_id=uid and source_pending_id=pending) <> 1
 then raise exception 'DUPLICATE_CONFIRMED_TRANSACTION'; end if;
 if (select count(*) from public.audit_logs where user_id=uid and entity_id=pending and action='confirm') <> 1
 then raise exception 'AUDIT_COUNT_BAD'; end if;
 raise notice 'PASS: unapproved exclusion, balanced ledger, replay, stale rejection, audit';
end;
$$;
rollback;
