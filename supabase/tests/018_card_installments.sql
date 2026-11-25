begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','18181818-1818-4181-8181-111111111111',true);
do $$
declare
 bank uuid := public.create_krw_payment_account('Installment bank','asset');
 card uuid := public.create_krw_payment_account('Installment card','liability');
 category uuid := public.create_krw_expense_category('Installment expense');
 draft uuid;
 purchase uuid;
 reversed_purchase uuid;
 cash_purchase uuid;
 plan jsonb;
 row_data jsonb;
begin
 perform public.record_account_opening_balance(bank,'15000','2024-01-01T00:00:00+09:00');
 perform public.record_account_opening_balance(card,'0','2024-01-01T00:00:00+09:00');
 draft := public.create_pending_expense('10001 in three installments',10001,'2024-01-31T15:00:00Z','credit_card',card,category);
 purchase := (public.approve_pending_expense(draft,1,gen_random_uuid())->>'transaction_id')::uuid;
 if public.get_card_installment_plan(purchase)->>'purchase_month' is distinct from '2024-02'
  or public.get_card_installment_plan(purchase)->>'version' is distinct from '0'
 then raise exception 'INITIAL_PLAN_OR_TIMEZONE_INVALID'; end if;
 begin
  perform public.save_card_installment_plan(purchase,0,'2024-01-01',3,'10001','100');
  raise exception 'EXPECTED_SCHEDULE_BEFORE_PURCHASE';
 exception when invalid_parameter_value then
  if sqlerrm<>'INSTALLMENT_MONTH_INVALID' then raise; end if;
 end;

 plan := public.save_card_installment_plan(purchase,0,'2024-02-01',3,'10001','100');
 row_data := public.list_card_installments('2024-02-01')->0;
 if plan->>'version' is distinct from '1' or row_data->>'principal_minor' is distinct from '3334'
  or row_data->>'fee_minor' is distinct from '34' or row_data->>'payment_number' is distinct from '1'
  or public.list_card_installments('2024-03-01')->0->>'principal_minor' is distinct from '3334'
  or public.list_card_installments('2024-03-01')->0->>'fee_minor' is distinct from '33'
  or public.list_card_installments('2024-04-01')->0->>'principal_minor' is distinct from '3333'
  or public.list_card_installments('2024-04-01')->0->>'fee_minor' is distinct from '33'
  or public.list_card_installments('2024-05-01') is distinct from '[]'::jsonb
 then raise exception 'INSTALLMENT_ROUNDING_OR_MONTH_INVALID'; end if;
 begin
  perform public.save_card_installment_plan(purchase,0,'2024-02-01',3,'10001','100');
  raise exception 'EXPECTED_INSTALLMENT_VERSION_CONFLICT';
 exception when unique_violation then
  if sqlerrm<>'INSTALLMENT_VERSION_CONFLICT' then raise; end if;
 end;
 perform public.post_account_movement('card_payment','3334','2024-03-01T09:00:00+09:00',gen_random_uuid(),bank,card);
 if public.summarize_confirmed_purchases('2024-02-01')->>'spending_minor' is distinct from '10001'
  or public.summarize_confirmed_purchases('2024-03-01')->>'spending_minor' is distinct from '0'
  or not exists (select 1 from public.list_account_balances() where id=card and balance_minor='6667')
 then raise exception 'INSTALLMENT_OR_PAYMENT_DOUBLE_COUNTED'; end if;

 perform public.post_account_movement('purchase_refund','1001','2024-03-03T09:00:00+09:00',gen_random_uuid(),null,null,purchase);
 row_data := public.list_card_installments('2024-03-01')->0;
 if row_data->>'needs_review' is distinct from 'true' or row_data->>'principal_minor' is not null
  or public.get_card_installment_plan(purchase)->>'available_minor' is distinct from '9000'
 then raise exception 'REFUNDED_INSTALLMENT_INCLUDED_IN_FORECAST'; end if;
 begin
  perform public.save_card_installment_plan(purchase,1,'2024-03-01',2,'9001','0');
  raise exception 'EXPECTED_EXCESS_PRINCIPAL';
 exception when invalid_parameter_value then
  if sqlerrm<>'INSTALLMENT_PRINCIPAL_INVALID' then raise; end if;
 end;
 plan := public.save_card_installment_plan(purchase,1,'2024-03-01',2,'9000','0');
 if plan->>'version' is distinct from '2'
  or public.list_card_installments('2024-03-01')->0->>'principal_minor' is distinct from '4500'
 then raise exception 'REFUNDED_PLAN_NOT_RESTORED_AFTER_EDIT'; end if;
 plan := public.save_card_installment_plan(purchase,2,null,null,null,null);
 if plan->>'version' is distinct from '3' or public.list_card_installments('2024-03-01') is distinct from '[]'::jsonb
 then raise exception 'CLEARED_PLAN_STILL_IN_FORECAST'; end if;

 draft := public.create_pending_expense('Later reversed',1000,'2024-05-01T09:00:00+09:00','credit_card',card,category);
 reversed_purchase := (public.approve_pending_expense(draft,1,gen_random_uuid())->>'transaction_id')::uuid;
 perform public.save_card_installment_plan(reversed_purchase,0,'2024-05-01',2,'1000','0');
 perform public.reverse_confirmed_purchase(reversed_purchase,'Entry mistake');
 if public.list_card_installments('2024-05-01') is distinct from '[]'::jsonb
  or public.get_card_installment_plan(reversed_purchase)->>'reversed' is distinct from 'true'
 then raise exception 'REVERSED_PLAN_STILL_IN_FORECAST'; end if;
 draft := public.create_pending_expense('Cash is ineligible',1000,'2024-05-01T09:00:00+09:00','cash',bank,category);
 cash_purchase := (public.approve_pending_expense(draft,1,gen_random_uuid())->>'transaction_id')::uuid;
 if public.get_card_installment_plan(cash_purchase) is not null then raise exception 'CASH_HAS_INSTALLMENT_PLAN'; end if;

 perform set_config('request.jwt.claim.sub','18181818-1818-4181-8181-222222222222',true);
 if exists (select 1 from public.card_installment_plans)
  or public.get_card_installment_plan(purchase) is not null
  or public.list_card_installments('2024-04-01') is distinct from '[]'::jsonb
 then raise exception 'OTHER_USER_INSTALLMENTS_VISIBLE'; end if;
 begin
  perform public.save_card_installment_plan(purchase,3,'2024-03-01',2,'9000','0');
  raise exception 'EXPECTED_OTHER_USER_PLAN_REJECTED';
 exception when no_data_found then
  if sqlerrm<>'INSTALLMENT_PURCHASE_NOT_FOUND' then raise; end if;
 end;
end;
$$;
set constraints all immediate;
rollback;
