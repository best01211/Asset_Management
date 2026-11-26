begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','12345678-0000-4000-8000-000000000061',true);
do $$
declare
 uid uuid:=auth.uid();
 cash uuid:=public.create_krw_payment_account('Recurring test bank','asset');
 category uuid:=public.create_krw_expense_category('Recurring test category');
 month_end_id uuid:=gen_random_uuid();
 yearly uuid:=gen_random_uuid();
 exact_id uuid:=gen_random_uuid();
 different_id uuid:=gen_random_uuid();
 ambiguous_one uuid:=gen_random_uuid();
 ambiguous_two uuid:=gen_random_uuid();
 paused_id uuid:=gen_random_uuid();
 late_id uuid:=gen_random_uuid();
 exact_occ uuid;
 partial_occ uuid;
 paused_occ uuid;
 late_occ uuid;
 exact_tx uuid;
 partial_tx uuid;
 ambiguous_tx uuid;
 draft uuid;
 day date:=(now() at time zone 'Asia/Seoul')::date;
 due date:=day+1;
 late_day date:=day-1;
 test_month date:=date_trunc('month',due)::date;
 data jsonb;
 settings jsonb;
 alert uuid;
begin
 settings:=jsonb_build_object('name','Monthly fixture','amount_minor','9000','currency','KRW',
  'anchor_on','2024-01-31','cycle_unit','month','cycle_count',1,'status','active','account_id',cash,
  'category_id',category,'aliases',array['Billed name'],'auto_match',true,'web_enabled',true,'advance_days',3,
  'unmatched_alert',true,'push_enabled',false,'note','test');
 perform public.save_recurring_service(month_end_id,0,settings);
 perform public.save_recurring_service(month_end_id,0,settings);
 perform public.save_recurring_service(yearly,0,settings||jsonb_build_object('name','Annual fixture','cycle_count',12));
 data:=public.read_recurring_month('2024-02-01');
 if jsonb_array_length(data->'occurrences')<>1 or data->'occurrences'->0->>'due_on'<>'2024-02-29'
  or data->'occurrences'->0->>'status'<>'needs_review' then raise exception 'month-end or annual handling failed'; end if;
 if jsonb_array_length(public.read_recurring_month('2024-02-01')->'occurrences')<>1 then raise exception 'duplicates on regeneration'; end if;
 if not exists(select 1 from jsonb_array_elements(public.read_recurring_month('2025-01-01')->'occurrences') v
  where v->>'service_id'=yearly::text and v->>'due_on'='2025-01-31') then raise exception 'annual payment does not recur'; end if;

 settings:=settings||jsonb_build_object('anchor_on',due,'effective_on',day,'aliases',array[]::text[]);
 perform public.save_recurring_service(exact_id,0,settings||jsonb_build_object('name','Primary subscription','aliases',array['Exact vendor']));
 perform public.save_recurring_service(different_id,0,settings||jsonb_build_object('name','Partial subscription'));
 perform public.save_recurring_service(ambiguous_one,0,settings||jsonb_build_object('name','Shared vendor'));
 perform public.save_recurring_service(ambiguous_two,0,settings||jsonb_build_object('name','Shared vendor'));
 perform public.save_recurring_service(paused_id,0,settings||jsonb_build_object('name','Pause test','cycle_unit','day','cycle_count',7));
 perform public.save_recurring_service(late_id,0,settings||jsonb_build_object('name','Late test','anchor_on',late_day,'effective_on',late_day));

 data:=public.read_recurring_month(test_month);
 select id into exact_occ from public.recurring_occurrences where service_id=exact_id and due_on=due;
 select id into partial_occ from public.recurring_occurrences where service_id=different_id and due_on=due;
 select id into paused_occ from public.recurring_occurrences where service_id=paused_id and due_on=due;
 select id into late_occ from public.recurring_occurrences where service_id=late_id and due_on=late_day;
 if exact_occ is null or partial_occ is null or paused_occ is null or late_occ is null then raise exception 'occurrence IDs missing'; end if;
 if not exists(select 1 from jsonb_array_elements(data->'occurrences') v where v->>'id'=exact_occ::text and v->>'status'='scheduled') then
  raise exception 'upcoming occurrence should be scheduled'; end if;

 select id into alert from public.recurring_web_alerts where occurrence_id=exact_occ and kind='advance';
 if alert is null or not exists(select 1 from public.recurring_web_alerts where occurrence_id=late_occ and kind='overdue') then
  raise exception 'web alerts missing'; end if;
 perform public.read_recurring_alert(alert);
 perform public.read_recurring_month(test_month);
 if (select count(*) from public.recurring_web_alerts where occurrence_id=exact_occ and kind='advance')<>1
  or not exists(select 1 from public.recurring_web_alerts where id=alert and read_at is not null)
  then raise exception 'duplicate alert or unread after opening'; end if;

 draft:=public.create_pending_expense('Exact vendor',9000,due::timestamp at time zone 'Asia/Seoul','cash',cash,category);
 if exists(select 1 from public.recurring_transaction_links where occurrence_id=exact_occ) then
  raise exception 'matched before approval'; end if;
 exact_tx:=(public.approve_pending_expense(draft,1,gen_random_uuid())->>'transaction_id')::uuid;
 if not exists(select 1 from public.recurring_transaction_links where occurrence_id=exact_occ
  and transaction_id=exact_tx and method='automatic') then raise exception 'exact approved payment did not match'; end if;
 draft:=public.create_pending_expense('Partial subscription',3000,due::timestamp at time zone 'Asia/Seoul','cash',cash,category);
 partial_tx:=(public.approve_pending_expense(draft,1,gen_random_uuid())->>'transaction_id')::uuid;
 if not exists(select 1 from public.recurring_occurrences where id=partial_occ and match_issue='different_amount')
  or exists(select 1 from public.recurring_transaction_links where transaction_id=partial_tx)
  then raise exception 'inexact amount auto linked'; end if;
 perform public.change_recurring_occurrence(partial_occ,'link',partial_tx,false);
 data:=public.read_recurring_month(test_month,true);
 if not exists(select 1 from jsonb_array_elements(data->'occurrences') v where v->>'id'=partial_occ::text
  and v->>'remaining_minor'='6000' and v->>'actual_minor'='3000' and v->>'status'='needs_review')
  or not exists(select 1 from jsonb_array_elements(data->'occurrences') v where v->>'id'=exact_occ::text
  and v->>'remaining_minor'='0' and v->>'status'='completed')
  or data->'ledger_summary'->>'spending_minor'<>'12000' then raise exception 'double count or partial payment wrong'; end if;

 draft:=public.create_pending_expense('Shared vendor',9000,due::timestamp at time zone 'Asia/Seoul','cash',cash,category);
 ambiguous_tx:=(public.approve_pending_expense(draft,1,gen_random_uuid())->>'transaction_id')::uuid;
 if (select count(*) from public.recurring_occurrences where service_id in (ambiguous_one,ambiguous_two)
  and due_on=due and match_issue='ambiguous')<>2 or exists(select 1 from public.recurring_transaction_links where transaction_id=ambiguous_tx)
  then raise exception 'ambiguous matching wrong'; end if;
 begin
  perform public.change_recurring_occurrence(paused_occ,'link',exact_tx,true);
  raise exception 'duplicate link accepted';
 exception when unique_violation then
  if sqlerrm<>'TRANSACTION_ALREADY_LINKED' then raise; end if;
 end;

 perform public.save_recurring_service(paused_id,1,settings||jsonb_build_object('name','Pause test','cycle_unit','day','cycle_count',7,'status','paused'));
 data:=public.read_recurring_month(test_month);
 if not exists(select 1 from jsonb_array_elements(data->'occurrences') v where v->>'id'=paused_occ::text
   and v->>'status'='skipped' and v->>'remaining_minor'='0') then raise exception 'pause not applied'; end if;
 perform public.save_recurring_service(paused_id,2,settings||jsonb_build_object('name','Pause test','cycle_unit','day','cycle_count',7));
 data:=public.read_recurring_month(test_month);
 if not exists(select 1 from jsonb_array_elements(data->'occurrences') v where v->>'id'=paused_occ::text
   and v->>'status'='scheduled') then raise exception 'resuming did not reopen'; end if;
 perform public.save_recurring_service(paused_id,3,settings||jsonb_build_object('name','Pause test',
  'cycle_unit','day','cycle_count',7,'anchor_on',due+2));
 data:=public.read_recurring_month(date_trunc('month',due+2)::date);
 if not exists(select 1 from jsonb_array_elements(data->'occurrences') v where v->>'service_id'=paused_id::text
   and v->>'due_on'=(due+2)::text and v->>'status'='scheduled')
  or exists(select 1 from jsonb_array_elements(data->'alerts') v where v->>'occurrence_id'=paused_occ::text)
  then raise exception 'rescheduling retained obsolete reminder'; end if;
 perform public.save_recurring_service(different_id,1,settings||jsonb_build_object('name','Partial subscription','status','cancelled'));
 data:=public.read_recurring_month(test_month);
 if not exists(select 1 from jsonb_array_elements(data->'occurrences') v where v->>'id'=partial_occ::text
   and v->>'status'='skipped' and v->>'actual_minor'='3000' and v->>'remaining_minor'='0')
  then raise exception 'cancellation lost payment or retained future obligation'; end if;
 perform public.save_recurring_service(exact_id,1,settings||jsonb_build_object('name','Primary subscription','status','cancelled','amount_minor','7000'));
 data:=public.read_recurring_service_history(exact_id);
 if data->'payments'->0->>'actual_minor'<>'9000' or jsonb_array_length(data->'revisions')<>2
  then raise exception 'completed occurrence or revision history changed'; end if;
 draft:=public.create_pending_expense('Manually completed fixture',8000,late_day::timestamp at time zone 'Asia/Seoul','cash',cash,category);
 partial_tx:=(public.approve_pending_expense(draft,1,gen_random_uuid())->>'transaction_id')::uuid;
 perform public.change_recurring_occurrence(late_occ,'link',partial_tx,true);
 data:=public.read_recurring_month(date_trunc('month',late_day)::date);
 if not exists(select 1 from jsonb_array_elements(data->'occurrences') v where v->>'id'=late_occ::text
   and v->>'status'='completed' and v->>'remaining_minor'='0' and v->>'actual_minor'='8000')
  then raise exception 'explicit payment completion ignored amount difference'; end if;

 perform set_config('request.jwt.claim.sub','12345678-0000-4000-8000-000000000062',true);
 if exists(select 1 from public.recurring_services where user_id=uid)
  or exists(select 1 from public.recurring_web_alerts where id=alert)
  or public.read_recurring_service_history(exact_id) is not null
  or jsonb_array_length(public.read_recurring_month(test_month)->'occurrences')<>0
  then raise exception 'other account can read recurring data'; end if;
 begin
  perform public.change_recurring_occurrence(exact_occ,'unlink',exact_tx,false);
  raise exception 'other account can change link';
 exception when no_data_found then null;
 end;
end
$$;
set constraints all immediate;
rollback;
