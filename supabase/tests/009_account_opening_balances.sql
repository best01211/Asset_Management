begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','99999999-0000-4000-8000-000000000001',true);
do $$
declare
 uid uuid := auth.uid();
 cutoff constant timestamptz := '2024-01-01T09:00:00+09:00';
 bank uuid;
 card uuid;
 zero_account uuid;
 unregistered uuid;
 expense uuid;
 category uuid;
 draft uuid;
 balance_tx uuid;
 result jsonb;
begin
 insert into public.financial_accounts(user_id,name,kind) values(uid,'Opening test bank','asset') returning id into bank;
 insert into public.financial_accounts(user_id,name,kind) values(uid,'Opening test card','liability') returning id into card;
 insert into public.financial_accounts(user_id,name,kind) values(uid,'Zero account','asset') returning id into zero_account;
 insert into public.financial_accounts(user_id,name,kind) values(uid,'Unregistered account','asset') returning id into unregistered;
 insert into public.financial_accounts(user_id,name,kind) values(uid,'Opening test expense','expense') returning id into expense;
 insert into public.categories(user_id,name,expense_account_id) values(uid,'Opening test category',expense) returning id into category;

 draft := public.create_pending_expense('Earlier bank purchase',1000,cutoff-interval '1 second','debit_card',bank,category);
 perform public.approve_pending_expense(draft,1,gen_random_uuid());
 draft := public.create_pending_expense('Bank purchase at cutoff',4000,cutoff,'cash',bank,category);
 perform public.approve_pending_expense(draft,1,gen_random_uuid());
 draft := public.create_pending_expense('Card purchase after cutoff',5500,cutoff+interval '1 second','credit_card',card,category);
 perform public.approve_pending_expense(draft,1,gen_random_uuid());
 perform public.create_pending_expense('Pending purchase',7000,cutoff+interval '1 hour','cash',bank,category);
 draft := public.create_pending_expense('Future purchase',8500,'9998-01-01T00:00:00Z','cash',bank,category);
 perform public.approve_pending_expense(draft,1,gen_random_uuid());

 result := public.record_account_opening_balance(bank,'100000',cutoff);
 balance_tx := (result->>'transaction_id')::uuid;
 if (result->>'replayed')::boolean is not false
  or not exists(select 1 from public.ledger_entries where transaction_id=balance_tx and account_id=bank and side='debit' and amount_minor=100000)
 then raise exception 'BANK_OPENING_NOT_DEBITED'; end if;

 result := public.record_account_opening_balance(card,'20000',cutoff);
 if not exists(select 1 from public.ledger_entries where transaction_id=(result->>'transaction_id')::uuid
  and account_id=card and side='credit' and amount_minor=20000)
 then raise exception 'CARD_OPENING_NOT_CREDITED'; end if;

 result := public.record_account_opening_balance(zero_account,'0',cutoff);
 if result->>'transaction_id' is not null then raise exception 'ZERO_OPENING_POSTED'; end if;

 result := public.record_account_opening_balance(bank,'100000',cutoff);
 if (result->>'replayed')::boolean is not true or result->>'transaction_id' is distinct from balance_tx::text
 then raise exception 'OPENING_RETRY_CHANGED_TRANSACTION'; end if;
 begin
  perform public.record_account_opening_balance(bank,'101000',cutoff);
  raise exception 'EXPECTED_OPENING_DUPLICATE_REJECTION';
 exception when unique_violation then
  if sqlerrm <> 'OPENING_BALANCE_ALREADY_RECORDED' then raise; end if;
 end;

 if not exists (select 1 from public.list_account_balances() b where b.id=bank and b.balance_minor='96000' and b.purchase_change_minor='-4000')
  or not exists (select 1 from public.list_account_balances() b where b.id=card and b.balance_minor='25500')
  or not exists (select 1 from public.list_account_balances() b where b.id=zero_account and b.balance_minor='0')
  or not exists (select 1 from public.list_account_balances() b where b.id=unregistered and b.balance_minor is null)
 then raise exception 'BAD_OPENING_BALANCE_ROLL_FORWARD'; end if;
 if public.summarize_confirmed_purchases('2024-01-01')->>'spending_minor' is distinct from '10500'
 then raise exception 'OPENING_COUNTED_IN_PURCHASE_SPEND'; end if;

 perform set_config('request.jwt.claim.sub','99999999-0000-4000-8000-000000000002',true);
 if exists(select 1 from public.list_account_balances()) then raise exception 'OTHER_USER_ACCOUNTS_VISIBLE'; end if;
 begin
  perform public.record_account_opening_balance(bank,'1',cutoff);
  raise exception 'EXPECTED_OTHER_USER_WRITE_REJECTION';
 exception when no_data_found then
  if sqlerrm <> 'ACCOUNT_NOT_FOUND' then raise; end if;
 end;
end
$$;
set constraints all immediate;

reset role;
do $$
begin
 begin
  update public.account_opening_balances set amount_minor=1
  where user_id='99999999-0000-4000-8000-000000000001';
  raise exception 'EXPECTED_OPENING_MUTATION_REJECTION';
 exception when sqlstate '55000' then
  if sqlerrm <> 'CONFIRMED_LEDGER_IMMUTABLE' then raise; end if;
 end;
end
$$;
rollback;
