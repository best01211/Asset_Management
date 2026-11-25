begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','17171717-1717-4171-8171-111111111111',true);

do $$
declare
 bank uuid := public.create_krw_payment_account('Reversal bank','asset');
 meals uuid := public.create_krw_expense_category('Meals');
 goods uuid := public.create_krw_expense_category('Goods');
 draft uuid;
 purchase uuid;
 reversal uuid;
 refunded_purchase uuid;
 results jsonb;
begin
 draft := public.create_pending_expense('Entered in error',10001,'2024-01-31T14:59:00Z','cash',bank,meals);
 perform public.save_pending_purchase_splits(draft,1,jsonb_build_array(
  jsonb_build_object('category_id',meals,'amount_minor','6000'),
  jsonb_build_object('category_id',goods,'amount_minor','4001')
 ));
 purchase := (public.approve_pending_expense(draft,2,gen_random_uuid())->>'transaction_id')::uuid;
 results := public.reverse_confirmed_purchase(purchase,' Duplicate manual entry ');
 reversal := (results->>'transaction_id')::uuid;
 if results->>'replayed' is distinct from 'false'
  or not exists (select 1 from public.transactions where id=purchase and amount_minor=10001)
  or not exists (select 1 from public.transactions
   where id=reversal and kind='purchase_reversal' and occurred_at='2024-01-31T14:59:00Z')
  or (select count(*) from public.ledger_entries where transaction_id=reversal)<>3
 then raise exception 'REVERSAL_DID_NOT_PRESERVE_ORIGINAL'; end if;

 results := public.reverse_confirmed_purchase(purchase,'Duplicate manual entry');
 if results->>'replayed' is distinct from 'true' or results->>'transaction_id' is distinct from reversal::text
 then raise exception 'REVERSAL_NOT_REPLAYED'; end if;
 begin
  perform public.reverse_confirmed_purchase(purchase,'Different reason');
  raise exception 'EXPECTED_REASON_CONFLICT';
 exception when unique_violation then
  if sqlerrm<>'PURCHASE_ALREADY_REVERSED' then raise; end if;
 end;
 begin
  perform public.post_account_movement('purchase_refund','1','2024-02-01T00:00:00Z',gen_random_uuid(),null,null,purchase);
  raise exception 'EXPECTED_REFUND_TO_FAIL';
 exception when check_violation then
  if sqlerrm<>'PURCHASE_ALREADY_REVERSED' then raise; end if;
 end;

 results := public.summarize_confirmed_purchases('2024-01-01');
 if results->>'spending_minor' is distinct from '0' or results->>'purchase_count' is distinct from '0'
  or jsonb_array_length(results->'categories')<>0
  or results#>>'{accounts,0,change_minor}' is distinct from '0'
  or public.get_purchase_refund_details(purchase)->>'remaining_minor' is distinct from '0'
  or public.get_purchase_refund_details(purchase)->>'reversal_reason' is distinct from 'Duplicate manual entry'
  or not exists (
   select 1 from jsonb_array_elements(public.get_monthly_ledger_export('2024-01-01','transactions')) row_data
   where row_data->>0=reversal::text and row_data->>7=purchase::text
  )
 then raise exception 'REVERSAL_MISSING_FROM_SUMMARY_OR_EXPORT'; end if;

 draft := public.create_pending_expense('Refunded sale',2000,'2024-02-10T10:00:00Z','cash',bank,goods);
 refunded_purchase := (public.approve_pending_expense(draft,1,gen_random_uuid())->>'transaction_id')::uuid;
 perform public.post_account_movement('purchase_refund','1000','2024-02-12T10:00:00Z',gen_random_uuid(),null,null,refunded_purchase);
 begin
  perform public.reverse_confirmed_purchase(refunded_purchase,'Conflicts with refund');
  raise exception 'EXPECTED_REVERSAL_TO_FAIL';
 exception when check_violation then
  if sqlerrm<>'PURCHASE_HAS_REFUNDS' then raise; end if;
 end;

 perform set_config('request.jwt.claim.sub','17171717-1717-4171-8171-222222222222',true);
 if exists (select 1 from public.purchase_reversals where transaction_id=reversal)
 then raise exception 'OTHER_USER_REVERSAL_VISIBLE'; end if;
 begin
  perform public.reverse_confirmed_purchase(purchase,'Other user');
  raise exception 'EXPECTED_PURCHASE_NOT_FOUND';
 exception when no_data_found then
  if sqlerrm<>'ORIGINAL_PURCHASE_NOT_FOUND' then raise; end if;
 end;
end;
$$;
set constraints all immediate;
rollback;
