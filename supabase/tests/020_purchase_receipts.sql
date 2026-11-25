begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','20202020-2020-4020-8020-111111111111',true);
do $$
declare
 bank uuid := public.create_krw_payment_account('Receipt bank','asset');
 meals uuid := public.create_krw_expense_category('Meals');
 goods uuid := public.create_krw_expense_category('Goods');
 gifts uuid := public.create_krw_expense_category('Free items');
 draft uuid;
 purchase uuid;
 refund uuid;
 receipt jsonb;
 saved jsonb;
 summary jsonb;
begin
 draft := public.create_pending_expense('Receipt purchase',10001,'2024-01-03T10:00:00+09:00','cash',bank,meals);
 receipt := jsonb_build_object('source','manual','shipping_minor','1000','discount_minor','998','points_minor','1',
  'items',jsonb_build_array(
   jsonb_build_object('label',' First item ','category_id',meals,'gross_minor','6000','discount_minor','1000'),
   jsonb_build_object('label','Second item','category_id',goods,'gross_minor','5000','discount_minor','0'),
   jsonb_build_object('label','Free item','category_id',gifts,'gross_minor','400','discount_minor','400')
  ));
 begin
  perform public.save_purchase_receipt(draft,1,jsonb_set(receipt,'{discount_minor}','"999"'));
  raise exception 'EXPECTED_RECEIPT_TOTAL_MISMATCH';
 exception when invalid_parameter_value then
  if sqlerrm<>'RECEIPT_TOTAL_MISMATCH' then raise; end if;
 end;
 begin
  perform public.save_purchase_receipt(draft,1,jsonb_set(receipt,'{items,0,category_id}','"20202020-2020-4020-8020-000000000001"'));
  raise exception 'EXPECTED_UNKNOWN_RECEIPT_CATEGORY';
 exception when invalid_parameter_value then
  if sqlerrm<>'RECEIPT_CATEGORY_INVALID' then raise; end if;
 end;
 saved := public.save_purchase_receipt(draft,1,receipt);
 if saved->>'version' is distinct from '2' or saved#>>'{receipt,items,0,label}' is distinct from 'First item'
  or saved#>>'{receipt,items,0,net_minor}' is distinct from '5001'
  or saved#>>'{receipt,items,1,net_minor}' is distinct from '5000'
  or saved#>>'{receipt,items,2,net_minor}' is distinct from '0'
 then raise exception 'ITEM_ALLOCATION_OR_VERSION_INVALID: %',saved; end if;
 saved := public.save_purchase_receipt(draft,2,receipt);
 if saved->>'version' is distinct from '2' then raise exception 'UNCHANGED_RECEIPT_VERSION_BUMP'; end if;
 begin
  perform public.save_pending_purchase_splits(draft,2,'[]'::jsonb);
  raise exception 'EXPECTED_RECEIPT_ALLOCATION_PROTECTION';
 exception when object_not_in_prerequisite_state then
  if sqlerrm<>'RECEIPT_CONTROLS_SPLITS' then raise; end if;
 end;
 begin
  perform public.edit_pending_expense(draft,2,'Receipt purchase','11001','2024-01-03T10:00:00+09:00','cash',bank,meals);
  raise exception 'EXPECTED_REJECTION_FOR_AMOUNT_EDIT';
 exception when invalid_parameter_value then
  if sqlerrm<>'PENDING_SPLIT_AMOUNT_MISMATCH' then raise; end if;
 end;

 saved := public.save_purchase_receipt(draft,2,null);
 if saved->>'version' is distinct from '3' or saved->>'receipt' is not null
  or public.get_pending_purchase_splits(draft) is distinct from '[]'::jsonb
 then raise exception 'CLEAR_RECEIPT_LEFT_STALE_ALLOCATIONS'; end if;
 saved := public.save_purchase_receipt(draft,3,receipt);
 purchase := (public.approve_pending_expense(draft,4,gen_random_uuid())->>'transaction_id')::uuid;
 if not exists(select 1 from public.transaction_splits where transaction_id=purchase and category_id=meals and amount_minor=5001)
  or not exists(select 1 from public.transaction_splits where transaction_id=purchase and category_id=goods and amount_minor=5000)
  or (select count(*) from public.transaction_splits where transaction_id=purchase)<>2
  or public.get_purchase_receipt(draft)->>'confirmed_transaction_id' is distinct from purchase::text
 then raise exception 'POSTED_RECEIPT_NOT_LINKED'; end if;
 summary := public.summarize_confirmed_purchases('2024-01-01');
 if summary->>'spending_minor' is distinct from '10001' or summary->>'purchase_count' is distinct from '1'
 then raise exception 'RECEIPT_DUPLICATED_LEDGER_SPENDING'; end if;
 begin
  perform public.save_purchase_receipt(draft,5,null);
  raise exception 'EXPECTED_CONFIRMED_RECEIPT_FROZEN';
 exception when raise_exception then
  if sqlerrm<>'STALE_OR_NOT_REVIEWABLE' then raise; end if;
 end;

 refund := (public.post_account_movement('purchase_refund','3333','2024-02-09T09:00:00+09:00',gen_random_uuid(),null,null,purchase)->>'transaction_id')::uuid;
 if not exists(select 1 from public.refund_allocations where transaction_id=refund and category_id=meals and amount_minor=1667)
  or not exists(select 1 from public.refund_allocations where transaction_id=refund and category_id=goods and amount_minor=1666)
 then raise exception 'REFUND_NOT_ALLOCATED_BY_POSTED_RECEIPT_CATEGORIES'; end if;

 perform set_config('request.jwt.claim.sub','20202020-2020-4020-8020-222222222222',true);
 if exists (select 1 from public.purchase_receipts) then raise exception 'OTHER_USER_RECEIPT_VISIBLE'; end if;
 begin
  perform public.get_purchase_receipt(draft);
  raise exception 'EXPECTED_OTHER_USER_RECEIPT_REJECTED';
 exception when no_data_found then
  if sqlerrm<>'PENDING_NOT_FOUND' then raise; end if;
 end;
end;
$$;
set constraints all immediate;
rollback;
