-- Notification retry determinism and cross-user approval isolation.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','dddddddd-dddd-4ddd-8ddd-dddddddddddd',true);
select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare eid uuid; again uuid; pay uuid; exp uuid; cat uuid; pid uuid;
begin
 eid := public.record_notification_event('stable-event-1','com.example.bank',now(),'{}');
 again := public.record_notification_event('stable-event-1','com.example.bank',now(),'{}');
 if eid is distinct from again then raise exception 'EVENT_DUPLICATE'; end if;
 insert into public.financial_accounts(user_id,name,kind)
 values(auth.uid(),'Debit account','asset') returning id into pay;
 insert into public.financial_accounts(user_id,name,kind)
 values(auth.uid(),'Expense account','expense') returning id into exp;
 insert into public.categories(user_id,name,expense_account_id)
 values(auth.uid(),'General',exp) returning id into cat;
 pid := public.create_pending_expense('Store',1200,now(),'debit_card',pay,cat,eid);
 perform set_config('request.jwt.claim.sub','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',true);
 begin
   perform public.approve_pending_expense(pid,1,gen_random_uuid());
   raise exception 'CROSS_USER_APPROVAL_SUCCEEDED';
 exception when sqlstate 'P0002' then null;
 end;
 raise notice 'PASS: notification retry and cross-user approval denied';
end $$;
rollback;
