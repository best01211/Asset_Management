begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-111111111111',true);
do $$
declare
 bank uuid := public.create_krw_payment_account('CSV bank','asset');
 category uuid := public.create_krw_expense_category('CSV category');
 row_data jsonb;
 batch jsonb;
 imported jsonb;
 retried jsonb;
begin
 row_data := jsonb_build_object(
  'merchant','Market, "A"','amount_minor','9007199254740993','occurred_at','2024-01-05T10:00:00+09:00',
  'payment_method','cash','payment_account_id',bank,'category_id',category);
 batch := jsonb_build_array(row_data,row_data);

 begin
  perform public.import_pending_purchase_rows(jsonb_set(batch,'{1,payment_method}','"credit_card"'));
  raise exception 'EXPECTED_IMPORT_TO_FAIL_AT_WRONG_ACCOUNT';
 exception when invalid_parameter_value then
  if sqlerrm<>'CSV_ROW_REJECTED' then raise; end if;
 end;
 if exists(select 1 from public.pending_transactions) then raise exception 'FAILED_CSV_LEFT_PARTIAL_IMPORT'; end if;

 imported := public.import_pending_purchase_rows(batch);
 if jsonb_array_length(imported)<>2 or imported#>>'{0,row}' is distinct from '2' or imported#>>'{1,row}' is distinct from '3'
  or imported#>>'{0,pending_transaction_id}'=imported#>>'{1,pending_transaction_id}'
  or imported#>>'{0,status}' is distinct from 'pending_review'
  or imported#>>'{0,replayed}' is distinct from 'false'
  or (select count(*) from public.pending_transactions where amount_minor=9007199254740993)<>2
  or exists(select 1 from public.ledger_entries)
 then raise exception 'CSV_CREATED_WRONG_PENDING_ROWS_OR_POSTED_LEDGER'; end if;
 retried := public.import_pending_purchase_rows(batch);
 if retried#>>'{0,replayed}' is distinct from 'true'
  or retried#>>'{1,replayed}' is distinct from 'true'
  or retried#>>'{0,pending_transaction_id}' is distinct from imported#>>'{0,pending_transaction_id}'
  or retried#>>'{1,pending_transaction_id}' is distinct from imported#>>'{1,pending_transaction_id}'
  or (select count(*) from public.pending_transactions)<>2
 then raise exception 'REPLAYED_CSV_CREATED_DUPLICATES'; end if;

 perform set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
 begin
  perform public.import_pending_purchase_rows(batch);
  raise exception 'EXPECTED_CROSS_USER_CSV_REJECTION';
 exception when invalid_parameter_value then
  if sqlerrm<>'CSV_ROW_REJECTED' then raise; end if;
 end;
end;
$$;
rollback;
