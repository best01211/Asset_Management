-- Verify late parsing, safe retries, user isolation, and atomic failure on local PostgreSQL.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-eeee-4eee-8eee-eeeeeeeeeeee',true);

do $$
declare
 uid uuid := auth.uid();
 received_at constant timestamptz := '2026-11-25T08:00:00+09:00';
 first_payload constant jsonb := '{"status":"failed","error_code":"missing_fields"}';
 asset_id uuid;
 expense_id uuid;
 category uuid;
 stored_event_id uuid;
 stored_pending_id uuid;
 result jsonb;
 parsed jsonb;
 previous record;
begin
 insert into public.financial_accounts(user_id,name,kind)
 values(uid,'Test payment','asset') returning id into asset_id;
 insert into public.financial_accounts(user_id,name,kind)
 values(uid,'Test expense','expense') returning id into expense_id;
 insert into public.categories(user_id,name,expense_account_id)
 values(uid,'Test category',expense_id) returning id into category;

 result := public.ingest_notification_event('stable-1','com.example.bank',received_at,first_payload);
 stored_event_id := (result->>'event_id')::uuid;
 if result->>'status' is distinct from 'parse_failed' or result->>'pending_transaction_id' is not null
  or result is distinct from public.ingest_notification_event('stable-1','com.example.bank',received_at,first_payload)
  or not exists (select 1 from public.list_notification_recovery() r
   where r.event_id=stored_event_id and r.error_code='missing_fields')
 then raise exception 'FAILED_PARSE_NOT_RECOVERABLE'; end if;

 begin
  perform public.ingest_notification_event('stable-1','com.example.bank',received_at + interval '1 second',first_payload);
  raise exception 'EXPECTED_NOTIFICATION_CONFLICT';
 exception when unique_violation then
  if sqlerrm <> 'NOTIFICATION_EVENT_CONFLICT' then raise; end if;
 end;

 parsed := jsonb_build_object('status','parsed','merchant','Test shop','amount_minor',5500,
  'occurred_at','2026-11-25T08:00:00+09:00','payment_method','debit_card',
  'payment_account_id',asset_id,'category_id',category);

 result := public.ingest_notification_event('stable-1','com.example.bank',received_at,
  parsed || jsonb_build_object('payment_account_id',expense_id));
 if result->>'error_code' is distinct from 'account_category_mismatch'
  or not exists (select 1 from public.list_notification_recovery() r
   where r.event_id=stored_event_id and r.error_code='account_category_mismatch')
 then raise exception 'ACCOUNT_MAPPING_NOT_RECOVERABLE'; end if;

 result := public.ingest_notification_event('stable-1','com.example.bank',received_at,parsed);
 stored_pending_id := (result->>'pending_transaction_id')::uuid;
 if stored_pending_id is null or result->>'status' is distinct from 'candidate_ready'
  or result is distinct from public.ingest_notification_event('stable-1','com.example.bank',received_at,first_payload)
  or result is distinct from public.ingest_notification_event('stable-1','com.example.bank',received_at,
   parsed || '{"occurred_at":"2026-11-24T23:00:00Z"}')
  or exists(select 1 from public.list_notification_recovery() r where r.event_id=stored_event_id)
  or exists(select 1 from public.transactions t where t.source_pending_id=stored_pending_id)
 then raise exception 'RECOVERED_CANDIDATE_INVALID'; end if;

 begin
  perform public.ingest_notification_event('stable-1','com.example.bank',received_at,parsed || '{"amount_minor":5501}');
  raise exception 'EXPECTED_CANDIDATE_CONFLICT';
 exception when unique_violation then
  if sqlerrm <> 'NOTIFICATION_EVENT_CONFLICT' then raise; end if;
 end;

 begin
  perform public.ingest_notification_event('invalid','com.example.bank',received_at,first_payload || '{"raw_text":"test"}');
  raise exception 'EXPECTED_RAW_FIELD_REJECTION';
 exception when invalid_parameter_value then null;
 end;
 if exists (select 1 from public.notification_events where device_event_id='invalid')
  or exists(select 1 from public.notification_events where id=stored_event_id and payload<>'{}'::jsonb)
 then raise exception 'UNEXPECTED_NOTIFICATION_PAYLOAD_STORED'; end if;

 -- A distinct OS event can represent a different payment with identical fields.
 result := public.ingest_notification_event('stable-2','com.example.bank',received_at,parsed);
 if result->>'pending_transaction_id' is null or result->>'pending_transaction_id' is not distinct from stored_pending_id::text
 then raise exception 'DISTINCT_EVENTS_MERGED'; end if;

 perform public.ingest_notification_event('failed-2','com.example.bank',received_at,first_payload);
 perform public.ingest_notification_event('failed-3','com.example.bank',received_at,first_payload);
 select r.* into strict previous from public.list_notification_recovery(null,null,1) r;
 if (select count(*) from public.list_notification_recovery(previous.received_at,previous.event_id,1))<>1
  or exists (select 1 from public.list_notification_recovery(previous.received_at,previous.event_id,1) r
   where r.event_id=previous.event_id) then raise exception 'RECOVERY_CURSOR_REPEATED_OR_SKIPPED'; end if;

 perform set_config('request.jwt.claim.sub','22222222-eeee-4eee-8eee-eeeeeeeeeeee',true);
 if exists (select 1 from public.list_notification_recovery())
 then raise exception 'OTHER_USER_RECOVERY_VISIBLE'; end if;
end
$$;
rollback;

begin;
create function pg_temp.reject_test_candidate() returns trigger
language plpgsql as $$
begin
 raise exception 'TEST_CANDIDATE_WRITE_FAILURE' using errcode='23514';
end;
$$;
create trigger reject_test_candidate before insert on public.pending_transactions
 for each row execute function pg_temp.reject_test_candidate();

set local role authenticated;
select set_config('request.jwt.claim.sub','33333333-eeee-4eee-8eee-eeeeeeeeeeee',true);
do $$
declare
 uid uuid := auth.uid();
 asset_id uuid;
 expense_id uuid;
 category uuid;
begin
 insert into public.financial_accounts(user_id,name,kind)
 values(uid,'Test payment','asset') returning id into asset_id;
 insert into public.financial_accounts(user_id,name,kind)
 values(uid,'Test expense','expense') returning id into expense_id;
 insert into public.categories(user_id,name,expense_account_id)
 values(uid,'Test category',expense_id) returning id into category;
 begin
  perform public.ingest_notification_event('roll-back','com.example.bank','2026-11-25T08:00:00+09:00',
   jsonb_build_object('status','parsed','merchant','Test','amount_minor',1000,
    'occurred_at','2026-11-25T08:00:00+09:00','payment_method','debit_card',
    'payment_account_id',asset_id,'category_id',category));
  raise exception 'EXPECTED_CANDIDATE_WRITE_FAILURE';
 exception when check_violation then
  if sqlerrm <> 'TEST_CANDIDATE_WRITE_FAILURE' then raise; end if;
 end;
 if exists (select 1 from public.notification_events where device_event_id='roll-back')
 or exists (select 1 from public.pending_transactions where user_id=uid)
 then raise exception 'PARTIAL_INGESTION_RETAINED'; end if;
end
$$;
rollback;
