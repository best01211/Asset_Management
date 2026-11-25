begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','21212121-2121-4121-8121-111111111111',true);
do $$
declare
 bank uuid := public.create_krw_payment_account('Closing bank','asset');
 card uuid := public.create_krw_payment_account('Closing card','liability');
 uninitialized uuid := public.create_krw_payment_account('Closing no opening','asset');
 category uuid := public.create_krw_expense_category('Closing meals');
 draft uuid;
 purchase uuid;
 result jsonb;
 old_snapshot jsonb;
begin
 perform public.record_account_opening_balance(bank,'15000','2024-01-01T00:00:00+09:00');
 perform public.record_account_opening_balance(card,'1000','2024-01-02T00:00:00+09:00');
 perform public.save_monthly_budget('2024-01-01',null,'20000',0);
 draft := public.create_pending_expense('January credit',10001,'2024-01-31T14:59:59Z','credit_card',card,category);
 purchase := (public.approve_pending_expense(draft,1,gen_random_uuid())->>'transaction_id')::uuid;
 draft := public.create_pending_expense('February only',2000,'2024-01-31T15:00:00Z','cash',bank,category);
 perform public.approve_pending_expense(draft,1,gen_random_uuid());
 draft := public.create_pending_expense('Uninitialized cash',500,'2024-01-04T10:00:00+09:00','cash',uninitialized,category);
 perform public.approve_pending_expense(draft,1,gen_random_uuid());
 draft := public.create_pending_expense('Still pending',3000,'2024-01-05T10:00:00+09:00','cash',bank,category);

 result := public.get_monthly_financial_closing('2024-01-01');
 if result->>'latest_version' is distinct from '0' or result->>'saved' is not null
  or result#>>'{current,ledger,spending_minor}' is distinct from '10501'
  or result#>>'{current,budget,total,amount_minor}' is distinct from '20000'
  or result#>>'{current,known_net_assets_minor}' is distinct from '3999'
  or result#>>'{current,unknown_balance_count}' is distinct from '1'
  or result#>>'{current,period_end}' is distinct from '2024-01-31T15:00:00Z'
 then raise exception 'JANUARY_CLOSING_CONTENT_INCORRECT: %',result; end if;

 result := public.save_monthly_financial_closing('2024-01-01',0);
 if result->>'latest_version' is distinct from '1' or result->>'changed' is distinct from 'false'
 then raise exception 'INITIAL_CLOSING_NOT_SAVED'; end if;
 old_snapshot := result->'saved'->'snapshot';
 perform set_config('TimeZone','Asia/Seoul',true);
 result := public.save_monthly_financial_closing('2024-01-01',1);
 if result->>'latest_version' is distinct from '1' or result->>'changed' is distinct from 'false'
 then raise exception 'UNCHANGED_CLOSING_CREATED_ANOTHER_VERSION'; end if;

 perform public.reverse_confirmed_purchase(purchase,'Incorrect purchase');
 result := public.get_monthly_financial_closing('2024-01-01');
 if result->>'changed' is distinct from 'true' or result->'saved'->'snapshot' is distinct from old_snapshot
  or result#>>'{current,ledger,spending_minor}' is distinct from '500'
  or result#>>'{current,known_net_assets_minor}' is distinct from '14000'
 then raise exception 'REVERSAL_DID_NOT_UPDATE_CURRENT_BUT_KEEP_SAVED_CLOSING'; end if;
 begin
  perform public.save_monthly_financial_closing('2024-01-01',0);
  raise exception 'EXPECTED_CLOSING_VERSION_CONFLICT';
 exception when unique_violation then
  if sqlerrm<>'CLOSING_VERSION_CONFLICT' then raise; end if;
 end;
 result := public.save_monthly_financial_closing('2024-01-01',1);
 if result->>'latest_version' is distinct from '2' or result->>'changed' is distinct from 'false'
  or public.get_monthly_financial_closing('2024-01-01',1)->'saved'->'snapshot' is distinct from old_snapshot
 then raise exception 'NEW_CLOSING_OVERWROTE_PRIOR_VERSION'; end if;

 begin
  perform public.save_monthly_financial_closing(date_trunc('month',statement_timestamp() at time zone 'Asia/Seoul')::date,0);
  raise exception 'EXPECTED_CLOSING_MONTH_IN_PROGRESS';
 exception when invalid_parameter_value then
  if sqlerrm<>'CLOSING_MONTH_IN_PROGRESS' then raise; end if;
 end;
 perform set_config('request.jwt.claim.sub','21212121-2121-4121-8121-222222222222',true);
 if exists(select 1 from public.monthly_financial_closings)
  or public.get_monthly_financial_closing('2024-01-01')->>'latest_version' is distinct from '0'
 then raise exception 'OTHER_USER_CLOSING_VISIBLE'; end if;
 begin
  perform public.get_monthly_financial_closing('2024-01-01',1);
  raise exception 'EXPECTED_OTHER_USER_CLOSING_REJECTED';
 exception when no_data_found then
  if sqlerrm<>'CLOSING_VERSION_NOT_FOUND' then raise; end if;
 end;
end;
$$;
set constraints all immediate;
rollback;
