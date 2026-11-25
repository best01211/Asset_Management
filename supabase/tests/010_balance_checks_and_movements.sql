begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','10101010-0000-4000-8000-000000000001',true);
do $$
declare
 uid uuid := auth.uid();
 bank uuid;
 savings uuid;
 card uuid;
 expense uuid;
 category uuid;
 draft uuid;
 card_purchase uuid;
 cash_purchase uuid;
 refund_id uuid;
 payment_key uuid := gen_random_uuid();
 check_key uuid := gen_random_uuid();
 response jsonb;
 result_again jsonb;
 month_summary jsonb;
begin
 insert into public.financial_accounts(user_id,name,kind) values(uid,'Movement bank','asset') returning id into bank;
 insert into public.financial_accounts(user_id,name,kind) values(uid,'Movement savings','asset') returning id into savings;
 insert into public.financial_accounts(user_id,name,kind) values(uid,'Movement credit','liability') returning id into card;
 insert into public.financial_accounts(user_id,name,kind) values(uid,'Movement expense','expense') returning id into expense;
 insert into public.categories(user_id,name,expense_account_id) values(uid,'Movement category',expense) returning id into category;
 perform public.record_account_opening_balance(bank,'100000','2024-01-01T00:00:00+09:00');
 perform public.record_account_opening_balance(savings,'20000','2024-01-01T00:00:00+09:00');
 perform public.record_account_opening_balance(card,'5000','2024-01-01T00:00:00+09:00');

 draft := public.create_pending_expense('Credit purchase',10000,'2024-01-02T10:00:00+09:00','credit_card',card,category);
 card_purchase := (public.approve_pending_expense(draft,1,gen_random_uuid())->>'transaction_id')::uuid;
 draft := public.create_pending_expense('Cash purchase',2000,'2024-01-02T11:00:00+09:00','cash',bank,category);
 cash_purchase := (public.approve_pending_expense(draft,1,gen_random_uuid())->>'transaction_id')::uuid;

 response := public.post_account_movement('card_payment','7000','2024-01-03T10:00:00+09:00',payment_key,bank,card);
 result_again := public.post_account_movement('card_payment','7000','2024-01-03T10:00:00+09:00',payment_key,bank,card);
 if result_again->>'transaction_id' is distinct from response->>'transaction_id'
  or result_again->>'replayed' is distinct from 'true' then raise exception 'PAYMENT_DOUBLE_POSTED'; end if;
 begin
  perform public.post_account_movement('card_payment','6000','2024-01-03T10:00:00+09:00',payment_key,bank,card);
  raise exception 'EXPECTED_REQUEST_CONFLICT';
 exception when unique_violation then
  if sqlerrm <> 'MOVEMENT_REQUEST_CONFLICT' then raise; end if;
 end;

 perform public.post_account_movement('own_transfer','4000','2024-01-04T08:00:00+09:00',gen_random_uuid(),bank,savings);
 refund_id := (public.post_account_movement('purchase_refund','3000','2024-01-05T08:00:00+09:00',
  gen_random_uuid(),null,null,card_purchase)->>'transaction_id')::uuid;
 if not exists (select 1 from public.ledger_entries where transaction_id=refund_id and account_id=card and side='debit')
  or not exists (select 1 from public.ledger_entries where transaction_id=refund_id and account_id=expense and side='credit')
  then raise exception 'REFUND_NOT_POSTED_AGAINST_PURCHASE_ACCOUNTS'; end if;
 begin
  perform public.post_account_movement('purchase_refund','7001','2024-01-05T08:00:00+09:00',
   gen_random_uuid(),null,null,card_purchase);
  raise exception 'EXPECTED_EXCESS_REFUND_REJECTION';
 exception when invalid_parameter_value then
  if sqlerrm <> 'REFUND_EXCEEDS_REMAINING' then raise; end if;
 end;

 response := public.record_account_balance_check(bank,'86800','2024-01-05T09:00:00+09:00',check_key);
 if response->>'ledger_minor' is distinct from '87000' or response->>'difference_minor' is distinct from '-200'
 then raise exception 'WRONG_BALANCE_AT_OBSERVATION: %',response; end if;
 perform public.post_account_movement('purchase_refund','500','2024-02-01T08:00:00+09:00',gen_random_uuid(),null,null,cash_purchase);
 result_again := public.record_account_balance_check(bank,'86800','2024-01-05T09:00:00+09:00',check_key);
 if result_again is distinct from response
  or (select count(*) from public.list_account_balance_checks())<>1
  or not exists (select 1 from public.list_account_balances() where id=bank and balance_minor='87500')
  or not exists (select 1 from public.list_account_balances() where id=savings and balance_minor='24000')
  or not exists (select 1 from public.list_account_balances() where id=card and balance_minor='5000')
 then raise exception 'BALANCE_MOVEMENT_OR_SNAPSHOT_CHANGED'; end if;

 month_summary := public.summarize_confirmed_purchases('2024-01-01');
 if month_summary->>'spending_minor' is distinct from '9000'
  or month_summary->>'gross_spending_minor' is distinct from '12000'
  or month_summary->>'refund_minor' is distinct from '3000'
  or month_summary->'categories'->0->>'amount_minor' is distinct from '9000'
  or public.summarize_confirmed_purchases('2024-02-01')->>'spending_minor' is distinct from '-500'
 then raise exception 'PAYMENT_OR_TRANSFER_COUNTED_AS_EXPENSE'; end if;

 perform set_config('request.jwt.claim.sub','10101010-0000-4000-8000-000000000002',true);
 if exists (select 1 from public.list_account_balance_checks())
  or exists (select 1 from public.calculate_account_balance(bank,'2024-01-05T09:00:00+09:00'))
 then raise exception 'CROSS_USER_BALANCE_CHECK_VISIBLE'; end if;
end
$$;
set constraints all immediate;
rollback;
