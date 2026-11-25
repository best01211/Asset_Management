begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','15151515-1515-4151-8151-111111111111',true);
do $$
declare
 uid uuid := auth.uid();
 payment_id uuid;
 meals uuid;
 goods uuid;
 first_expense uuid;
 second_expense uuid;
 draft_id uuid;
 posted_id uuid;
 first_refund uuid;
 last_refund uuid;
 first_key uuid := gen_random_uuid();
 plan jsonb;
 receipt jsonb;
 month_summary jsonb;
begin
 payment_id := public.create_krw_payment_account('Split bank','asset');
 meals := public.create_krw_expense_category('Meals');
 goods := public.create_krw_expense_category('Goods');
 select expense_account_id into first_expense from public.categories where id=meals;
 select expense_account_id into second_expense from public.categories where id=goods;
 draft_id := public.create_pending_expense('Combined purchase',10001,'2024-01-10T10:00:00Z','cash',payment_id,meals);
 plan := jsonb_build_array(jsonb_build_object('category_id',meals,'amount_minor','6000'),
  jsonb_build_object('category_id',goods,'amount_minor','4001'));

 begin
  perform public.save_pending_purchase_splits(draft_id,1,jsonb_set(plan,'{1,amount_minor}','"4000"'));
  raise exception 'EXPECTED_INVALID_SPLIT_TOTAL';
 exception when invalid_parameter_value then
  if sqlerrm<>'PENDING_SPLIT_AMOUNT_MISMATCH' then raise; end if;
 end;
 receipt := public.save_pending_purchase_splits(draft_id,1,plan);
 if receipt->>'version' is distinct from '2' or jsonb_array_length(public.get_pending_purchase_splits(draft_id))<>2
 then raise exception 'SPLIT_NOT_SAVED_WITH_VERSION'; end if;
 if public.save_pending_purchase_splits(draft_id,2,plan)->>'version' is distinct from '2'
 then raise exception 'UNCHANGED_SPLIT_VERSION_INCREMENTED'; end if;

 begin
  perform public.edit_pending_expense(draft_id,2,'Combined purchase','11000','2024-01-10T10:00:00Z','cash',payment_id,meals);
  raise exception 'EXPECTED_EDIT_SPLIT_MISMATCH';
 exception when invalid_parameter_value then
  if sqlerrm<>'PENDING_SPLIT_AMOUNT_MISMATCH' then raise; end if;
 end;
 begin
  perform public.approve_pending_expense(draft_id,1,gen_random_uuid());
  raise exception 'EXPECTED_STALE_APPROVAL_AFTER_SPLIT';
 exception when raise_exception then
  if sqlerrm<>'STALE_OR_NOT_REVIEWABLE' then raise; end if;
 end;
 posted_id := (public.approve_pending_expense(draft_id,2,gen_random_uuid())->>'transaction_id')::uuid;
 if not exists(select 1 from public.ledger_entries where transaction_id=posted_id and account_id=first_expense and side='debit' and amount_minor=6000)
  or not exists(select 1 from public.ledger_entries where transaction_id=posted_id and account_id=second_expense and side='debit' and amount_minor=4001)
  or not exists(select 1 from public.ledger_entries where transaction_id=posted_id and account_id=payment_id and side='credit' and amount_minor=10001)
 then raise exception 'APPROVED_SPLIT_LEDGER_INVALID'; end if;

 first_refund := (public.post_account_movement('purchase_refund','3333','2024-02-10T10:00:00Z',first_key,null,null,posted_id)->>'transaction_id')::uuid;
 if not exists(select 1 from public.refund_allocations where transaction_id=first_refund and category_id=meals and amount_minor=2000)
  or not exists(select 1 from public.refund_allocations where transaction_id=first_refund and category_id=goods and amount_minor=1333)
  or public.post_account_movement('purchase_refund','3333','2024-02-10T10:00:00Z',first_key,null,null,posted_id)
     ->>'transaction_id' is distinct from first_refund::text
  or public.get_purchase_refund_details(posted_id)->>'remaining_minor' is distinct from '6668'
 then raise exception 'PARTIAL_REFUND_ROUNDING_OR_REPLAY_INVALID'; end if;

 last_refund := (public.post_account_movement('purchase_refund','6668','2024-03-10T10:00:00Z',gen_random_uuid(),null,null,posted_id)->>'transaction_id')::uuid;
 if not exists(select 1 from public.refund_allocations where transaction_id=last_refund and category_id=meals and amount_minor=4000)
  or not exists(select 1 from public.refund_allocations where transaction_id=last_refund and category_id=goods and amount_minor=2668)
 then raise exception 'FINAL_REFUND_DID_NOT_CLEAR_CATEGORIES'; end if;

 month_summary := public.summarize_confirmed_purchases('2024-02-01');
 if month_summary->>'spending_minor' is distinct from '-3333'
  or not exists(select 1 from jsonb_array_elements(month_summary->'categories') c where c->>'id'=meals::text and c->>'amount_minor'='-2000')
  or not exists(select 1 from jsonb_array_elements(month_summary->'categories') c where c->>'id'=goods::text and c->>'amount_minor'='-1333')
 then raise exception 'REFUND_DOUBLE_COUNTED_OR_UNALLOCATED'; end if;

 perform set_config('request.jwt.claim.sub','15151515-1515-4151-8151-222222222222',true);
 if exists(select 1 from public.pending_purchase_splits where pending_id=draft_id)
  or exists(select 1 from public.refund_allocations where transaction_id=first_refund)
  or public.get_purchase_refund_details(posted_id) is not null
 then raise exception 'OTHER_USER_SPLITS_VISIBLE'; end if;
end
$$;
set constraints all immediate;
rollback;
