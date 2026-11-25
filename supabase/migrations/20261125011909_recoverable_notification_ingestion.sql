alter table public.notification_events
 add column parse_error_code text check (parse_error_code in
  ('unrecognized_format','missing_fields','ambiguous_payment','account_category_mismatch')),
 add column ingestion_candidate_hash bytea;

create index notification_events_recovery_idx
 on public.notification_events(user_id,received_at desc,id desc);

-- Both the legacy pending RPC and the new ingestion RPC serialize on this event.
create function public.lock_notification_for_candidate() returns trigger
language plpgsql set search_path = '' as $$
begin
 perform 1 from public.notification_events
 where user_id=new.user_id and id=new.notification_event_id
 for no key update;
 return new;
end;
$$;

create trigger notification_candidate_lock before insert on public.pending_transactions
 for each row when (new.notification_event_id is not null)
 execute function public.lock_notification_for_candidate();
revoke all on function public.lock_notification_for_candidate() from public,anon,authenticated;

create function public.ingest_notification_event(
 p_device_event_id text,p_source_package text,p_received_at timestamptz,p_extraction jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
 uid uuid := auth.uid();
 event_row public.notification_events%rowtype;
 candidate public.pending_transactions%rowtype;
 parse_status text := p_extraction->>'status';
 failure text;
 merchant_name text;
 amount_minor bigint;
 occurred_at timestamptz;
 method text;
 payment_account uuid;
 category uuid;
 submitted_hash bytea;
 stored_hash bytea;
 candidate_id uuid;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if coalesce(length(p_device_event_id),0) not between 1 and 200
  or trim(p_device_event_id)='' or p_source_package is null
  or length(p_source_package)>200 or p_source_package !~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'
  or p_received_at is null or not isfinite(p_received_at)
  or jsonb_typeof(p_extraction) is distinct from 'object' then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;

 if parse_status='failed' then
  failure := p_extraction->>'error_code';
  if failure is null or failure not in ('unrecognized_format','missing_fields','ambiguous_payment')
   or p_extraction - array['status','error_code'] <> '{}'::jsonb then
   raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
 elsif parse_status='parsed' then
  if p_extraction - array['status','merchant','amount_minor','occurred_at','payment_method','payment_account_id','category_id'] <> '{}'::jsonb
   or jsonb_typeof(p_extraction->'merchant') is distinct from 'string'
   or jsonb_typeof(p_extraction->'amount_minor') is distinct from 'number'
   or jsonb_typeof(p_extraction->'occurred_at') is distinct from 'string'
   or jsonb_typeof(p_extraction->'payment_account_id') is distinct from 'string'
   or jsonb_typeof(p_extraction->'category_id') is distinct from 'string' then
   raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  merchant_name := trim(p_extraction->>'merchant');
  method := p_extraction->>'payment_method';
  if length(merchant_name) not between 1 and 200 or method is null
   or method not in ('credit_card','debit_card','cash')
   or (p_extraction->>'amount_minor') !~ '^[0-9]{1,16}$'
   or (p_extraction->>'occurred_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' then
   raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  amount_minor := (p_extraction->>'amount_minor')::bigint;
  occurred_at := (p_extraction->>'occurred_at')::timestamptz;
  payment_account := (p_extraction->>'payment_account_id')::uuid;
  category := (p_extraction->>'category_id')::uuid;
  if amount_minor not between 1 and 9007199254740991 then
   raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  submitted_hash := sha256(convert_to(jsonb_build_array(
   merchant_name,amount_minor,extract(epoch from occurred_at),method,payment_account,category
  )::text,'UTF8'));
 else
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;

 -- The source package and initial receipt time describe the same OS event on every retry.
 insert into public.notification_events(user_id,device_event_id,source_package,received_at)
 values(uid,p_device_event_id,p_source_package,p_received_at)
 on conflict (user_id,device_event_id) do nothing;
 select * into strict event_row from public.notification_events
 where user_id=uid and device_event_id=p_device_event_id for no key update;
 if event_row.source_package<>p_source_package or event_row.received_at<>p_received_at then
  raise exception 'NOTIFICATION_EVENT_CONFLICT' using errcode='23505';
 end if;

 select * into candidate from public.pending_transactions
 where user_id=uid and notification_event_id=event_row.id;
 if found then
  if parse_status='parsed' then
   stored_hash := coalesce(event_row.ingestion_candidate_hash,sha256(convert_to(jsonb_build_array(
    candidate.merchant,candidate.amount_minor,extract(epoch from candidate.occurred_at),
    candidate.payment_method,candidate.payment_account_id,candidate.category_id
   )::text,'UTF8')));
   if stored_hash<>submitted_hash then
    raise exception 'NOTIFICATION_EVENT_CONFLICT' using errcode='23505';
   end if;
   if event_row.ingestion_candidate_hash is null then
    update public.notification_events set ingestion_candidate_hash=stored_hash,parse_error_code=null
    where user_id=uid and id=event_row.id;
   end if;
  end if;
  return jsonb_build_object('event_id',event_row.id,'status','candidate_ready',
   'pending_transaction_id',candidate.id,'error_code',null);
 end if;

 if parse_status='parsed' then
  begin
   candidate_id := public.create_pending_expense(
    merchant_name,amount_minor,occurred_at,method,payment_account,category,event_row.id);
  exception when invalid_parameter_value then
   if sqlerrm <> 'ACCOUNT_CATEGORY_MISMATCH' then raise; end if;
   failure := 'account_category_mismatch';
  end;
 end if;

 update public.notification_events
 set parse_error_code=failure,
     ingestion_candidate_hash=case when candidate_id is not null then submitted_hash end
 where user_id=uid and id=event_row.id;

 return jsonb_build_object('event_id',event_row.id,
  'status',case when candidate_id is null then 'parse_failed' else 'candidate_ready' end,
  'pending_transaction_id',candidate_id,'error_code',failure);
end;
$$;

-- Return recoverable events without exposing the legacy free-form payload.
create function public.list_notification_recovery(
 p_before_received_at timestamptz default null,p_before_id uuid default null,p_limit integer default 50
) returns table (event_id uuid,device_event_id text,source_package text,received_at timestamptz,
 status text,error_code text)
language plpgsql stable set search_path = '' as $$
declare uid uuid := auth.uid();
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if (p_before_received_at is null) <> (p_before_id is null)
  or p_limit is null or p_limit not between 1 and 101 then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;
 return query
 select e.id,e.device_event_id,e.source_package,e.received_at,
  case when e.parse_error_code is null then 'received' else 'parse_failed' end,
  e.parse_error_code
 from public.notification_events e
 where e.user_id=uid
  and (p_before_id is null or (e.received_at,e.id)<(p_before_received_at,p_before_id))
  and not exists (
   select 1 from public.pending_transactions p where p.user_id=uid and p.notification_event_id=e.id)
 order by e.received_at desc,e.id desc
 limit p_limit;
end;
$$;

revoke all on function public.ingest_notification_event(text,text,timestamptz,jsonb) from public,anon;
revoke all on function public.list_notification_recovery(timestamptz,uuid,integer) from public,anon;
grant execute on function public.ingest_notification_event(text,text,timestamptz,jsonb) to authenticated;
grant execute on function public.list_notification_recovery(timestamptz,uuid,integer) to authenticated;
