begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
do $$
declare
 uid uuid := auth.uid();
 bank uuid;
 savings uuid;
 card uuid;
 expense uuid;
 category uuid;
 receipt jsonb;
 actual_check uuid;
 stale_check uuid;
 adjustment uuid;
 fee_tx uuid;
 key uuid := gen_random_uuid();
 invalid_key uuid := gen_random_uuid();
 summary jsonb;
begin
 insert into public.financial_accounts(user_id,name,kind) values(uid,'Fee bank','asset') returning id into bank;
 insert into public.financial_accounts(user_id,name,kind) values(uid,'Fee savings','asset') returning id into savings;
 insert into public.financial_accounts(user_id,name,kind) values(uid,'Adjustment card','liability') returning id into card;
 insert into public.financial_accounts(user_id,name,kind) values(uid,'Fee expense','expense') returning id into expense;
 insert into public.categories(user_id,name,expense_account_id) values(uid,'Bank fees',expense) returning id into category;
 perform public.record_account_opening_balance(bank,'100000','2024-01-01T00:00:00Z');
 perform public.record_account_opening_balance(savings,'20000','2024-01-01T00:00:00Z');
 perform public.record_account_opening_balance(card,'5000','2024-01-01T00:00:00Z');

 begin
  perform public.post_own_transfer_with_fee('500','2024-01-02T08:00:00Z',invalid_key,bank,savings,'100',gen_random_uuid());
  raise exception 'EXPECTED_FEE_CATEGORY_REJECTION';
 exception when invalid_parameter_value then
  if sqlerrm <> 'FEE_CATEGORY_INVALID' then raise; end if;
 end;
 if exists(select 1 from public.account_movements where request_id=invalid_key)
 then raise exception 'INVALID_FEE_LEFT_TRANSFER'; end if;

 receipt := public.post_own_transfer_with_fee('10000','2024-01-02T09:00:00Z',key,bank,savings,'100',category);
 fee_tx := (receipt->>'fee_transaction_id')::uuid;
 if public.post_own_transfer_with_fee('10000','2024-01-02T09:00:00Z',key,bank,savings,'100',category)
  ->>'fee_transaction_id' is distinct from fee_tx::text then raise exception 'FEE_REPLAY_CHANGED'; end if;
 begin
  perform public.post_own_transfer_with_fee('10000','2024-01-02T09:00:00Z',key,bank,savings);
  raise exception 'EXPECTED_FEE_REPLAY_CONFLICT';
 exception when unique_violation then
  if sqlerrm <> 'MOVEMENT_REQUEST_CONFLICT' then raise; end if;
 end;
 if not exists(select 1 from public.ledger_entries where transaction_id=fee_tx and account_id=expense and side='debit' and amount_minor=100)
  or not exists(select 1 from public.list_account_balances() where id=bank and balance_minor='89900')
  or not exists(select 1 from public.list_account_balances() where id=savings and balance_minor='30000')
 then raise exception 'TRANSFER_FEE_ACCOUNTING_WRONG'; end if;

 actual_check := (public.record_account_balance_check(bank,'90000','2024-01-03T09:00:00Z',gen_random_uuid())->>'id')::uuid;
 adjustment := (public.approve_balance_adjustment(actual_check)->>'transaction_id')::uuid;
 if public.approve_balance_adjustment(actual_check)->>'transaction_id' is distinct from adjustment::text
  or not exists(select 1 from public.ledger_entries where transaction_id=adjustment and account_id=bank and side='debit' and amount_minor=100)
  or not exists(select 1 from public.list_account_balance_checks() where id=actual_check and adjustment_transaction_id=adjustment)
  or not exists(select 1 from public.list_account_balances() where id=bank and balance_minor='90000')
 then raise exception 'ASSET_ADJUSTMENT_INVALID'; end if;

 actual_check := (public.record_account_balance_check(card,'4900','2024-01-03T10:00:00Z',gen_random_uuid())->>'id')::uuid;
 adjustment := (public.approve_balance_adjustment(actual_check)->>'transaction_id')::uuid;
 if not exists(select 1 from public.ledger_entries where transaction_id=adjustment and account_id=card and side='debit' and amount_minor=100)
  or not exists(select 1 from public.list_account_balances() where id=card and balance_minor='4900')
 then raise exception 'LIABILITY_ADJUSTMENT_INVALID'; end if;

 stale_check := (public.record_account_balance_check(bank,'91000','2024-01-06T09:00:00Z',gen_random_uuid())->>'id')::uuid;
 perform public.post_own_transfer_with_fee('50','2024-01-05T09:00:00Z',gen_random_uuid(),bank,savings);
 begin
  perform public.approve_balance_adjustment(stale_check);
  raise exception 'EXPECTED_STALE_ADJUSTMENT_REJECTION';
 exception when raise_exception then
  if sqlerrm <> 'BALANCE_CHECK_STALE' then raise; end if;
 end;

 summary := public.summarize_confirmed_purchases('2024-01-01');
 if summary->>'spending_minor' is distinct from '100' or summary->>'fee_minor' is distinct from '100'
  or summary->>'gross_spending_minor' is distinct from '0' or summary->'categories'->0->>'amount_minor' is distinct from '100'
 then raise exception 'ADJUSTMENT_OR_PRINCIPAL_COUNTED_AS_EXPENSE'; end if;

 perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-222222222222',true);
 begin
  perform public.approve_balance_adjustment(actual_check);
  raise exception 'EXPECTED_OTHER_USER_ADJUSTMENT_REJECTION';
 exception when no_data_found then
  if sqlerrm <> 'BALANCE_CHECK_NOT_FOUND' then raise; end if;
 end;
 if exists(select 1 from public.transfer_fees) or exists(select 1 from public.balance_adjustments)
 then raise exception 'OTHER_USER_FINANCIAL_RECORDS_VISIBLE'; end if;
end
$$;
set constraints all immediate;
rollback;
