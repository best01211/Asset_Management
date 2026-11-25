create function public.import_pending_purchase_rows(p_rows jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
 uid uuid := auth.uid();
 batch_hash text;
 element record;
 row_data jsonb;
 request_id uuid;
 result jsonb;
 imported jsonb := '[]'::jsonb;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 if jsonb_array_length(p_rows) not between 1 and 100 then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 batch_hash := encode(sha256(convert_to(p_rows::text,'UTF8')),'hex');

 for element in select value,ordinality from jsonb_array_elements(p_rows) with ordinality loop
  row_data := element.value;
  if jsonb_typeof(row_data) is distinct from 'object' or coalesce(length(btrim(row_data->>'merchant')),0) not between 1 and 200
   or coalesce(row_data->>'payment_method','') not in ('credit_card','debit_card','cash')
   or row_data->>'payment_account_id' is null or row_data->>'category_id' is null
   or coalesce(row_data->>'amount_minor','') !~ '^[1-9][0-9]{0,18}$'
   or coalesce(row_data->>'occurred_at','') !~
     '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' then
   raise exception 'CSV_ROW_REJECTED' using errcode='22023',detail=(element.ordinality+1)::text;
  end if;
  request_id := substr(encode(sha256(convert_to('csv:'||batch_hash||':'||element.ordinality::text,'UTF8')),'hex'),1,32)::uuid;
  begin
   result := public.create_manual_pending_expense(
    row_data->>'merchant',(row_data->>'amount_minor')::bigint,(row_data->>'occurred_at')::timestamptz,
    row_data->>'payment_method',(row_data->>'payment_account_id')::uuid,(row_data->>'category_id')::uuid,request_id);
  exception when data_exception then
   raise exception 'CSV_ROW_REJECTED' using errcode='22023',detail=(element.ordinality+1)::text;
  end;
  imported := imported||jsonb_build_array(result||jsonb_build_object('row',element.ordinality+1));
 end loop;
 return imported;
end;
$$;
revoke all on function public.import_pending_purchase_rows(jsonb) from public,anon;
grant execute on function public.import_pending_purchase_rows(jsonb) to authenticated;
