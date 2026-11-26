-- Use the same category attribution, refund allocation, and reversal policy as the monthly ledger summary.
create function private.budget_daily_spending(p_from date,p_until date) returns jsonb
language sql stable set search_path='' as $$
 with activity as materialized (
  select t.*, (t.occurred_at at time zone 'Asia/Seoul')::date as day,exists (
    select 1 from public.purchase_reversals r where r.user_id=t.user_id and r.original_purchase_id=t.id) as reversed
  from public.transactions t where t.user_id=(select auth.uid()) and t.currency='KRW'
    and t.kind in ('purchase_credit','purchase_debit','purchase_cash','purchase_refund','transfer_fee')
    and t.occurred_at>=p_from::timestamp at time zone 'Asia/Seoul'
    and t.occurred_at<p_until::timestamp at time zone 'Asia/Seoul'
 ), purchases as (
  select a.day,a.id as purchase_id,null::bigint as refund from activity a
  where a.kind in ('purchase_credit','purchase_debit','purchase_cash') and not a.reversed
  union all
  select a.day,m.original_purchase_id,a.amount_minor from activity a
  join public.account_movements m on m.user_id=a.user_id and m.transaction_id=a.id
  where a.kind='purchase_refund' and not exists (
    select 1 from public.refund_allocations r where r.user_id=a.user_id and r.transaction_id=a.id)
 ), entries as (
  select p.day,c.category_id,case when p.refund is null then c.amount_minor else -p.refund end as amount,p.purchase_id
  from purchases p join public.reporting_purchase_categories c on c.user_id=(select auth.uid()) and c.transaction_id=p.purchase_id
  union all
  select a.day,c.category_id,-c.amount_minor,m.original_purchase_id from activity a
  join public.reporting_refund_categories c on c.user_id=a.user_id and c.transaction_id=a.id
  join public.account_movements m on m.user_id=a.user_id and m.transaction_id=a.id
  where a.kind='purchase_refund'
  union all
  select a.day,c.category_id,a.amount_minor,null from activity a
  join public.reporting_fee_categories c on c.user_id=a.user_id and c.transaction_id=a.id where a.kind='transfer_fee'
 ), classified as (
  select e.*, (l.transaction_id is not null or exists (
   select 1 from public.recurring_service_revisions revision
   where revision.user_id=t.user_id and revision.currency=t.currency and revision.account_id=p.payment_account_id
     and (private.recurring_name(t.merchant)=private.recurring_name(revision.name) or exists (
       select 1 from unnest(revision.aliases) alias where private.recurring_name(t.merchant)=private.recurring_name(alias)))
  )) as recurring
  from entries e left join public.recurring_transaction_links l on l.user_id=(select auth.uid()) and l.transaction_id=e.purchase_id
  left join public.transactions t on t.user_id=(select auth.uid()) and t.id=e.purchase_id
  left join public.pending_transactions p on p.user_id=t.user_id and p.id=t.source_pending_id
 ), daily as (
  select day,category_id,sum(amount)::text as amount_minor,
    coalesce(sum(amount) filter(where not recurring),0)::text as variable_minor,
    bool_or(not recurring and amount>0) as variable_day
  from classified group by day,category_id
  union all
  select day,null,sum(case when kind='purchase_refund' then -amount_minor else amount_minor end)::text,'0',false
  from activity where not reversed group by day
 )
 select coalesce(jsonb_agg(to_jsonb(daily) order by day,category_id),'[]'::jsonb) from daily
$$;

create function private.read_budget_workspace(p_month date) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 uid uuid:=auth.uid();
 today date:=private.recurring_today();
 until_day date;
 previous date;
 scheduled jsonb;
 pending jsonb;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_month is null or p_month not between date '1900-01-01' and date '9998-12-01' or extract(day from p_month)<>1
 then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 until_day:=(p_month+interval '1 month')::date;
 previous:=greatest((p_month-interval '1 month')::date,date '1900-01-01');
 perform private.recurring_lock(uid);
 perform private.materialize_recurring(uid,p_month,until_day-1);
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'service_id',s.service_id,'due_on',s.due_on,'name',r.name,
   'category_id',r.category_id,'account_name',a.name,'currency',s.currency,'remaining_minor',s.remaining_minor::text) order by s.due_on,s.id),'[]'::jsonb)
 into scheduled from private.recurring_state(uid,p_month,until_day-1) s
 join public.recurring_service_revisions r on r.user_id=uid and r.service_id=s.service_id and r.version=s.revision
 left join public.financial_accounts a on a.user_id=uid and a.id=r.account_id
 where s.remaining_minor>0;
 select jsonb_build_object('count',count(*) filter(where status='pending_review'),
   'won_minor',coalesce(sum(amount_minor) filter(where status='pending_review' and currency='KRW'),0)::text,
   'foreign_count',count(*) filter(where status='pending_review' and currency<>'KRW'),
   'duplicate_count',count(*) filter(where status='duplicate_suspected')) into pending
 from public.pending_transactions where user_id=uid and status in ('pending_review','duplicate_suspected')
   and occurred_at>=p_month::timestamp at time zone 'Asia/Seoul' and occurred_at<until_day::timestamp at time zone 'Asia/Seoul';

 return public.get_monthly_budget(p_month)||jsonb_build_object('today',today,'scheduled',scheduled,'pending',pending,
  'daily',private.budget_daily_spending(previous,until_day),
  'previous',case when previous<p_month then public.get_monthly_budget(previous) end);
end;
$$;

create function public.read_budget_workspace(p_month date) returns jsonb
language sql set search_path='' as $$ select private.read_budget_workspace(p_month) $$;

-- A failed version check rolls back every change. Sorting avoids cross-batch lock inversions.
create function public.save_budget_allocations(p_month date,p_changes jsonb) returns void
language plpgsql set search_path='' as $$
declare change record;
begin
 if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if jsonb_typeof(p_changes) is distinct from 'array' then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 if jsonb_array_length(p_changes) not between 1 and 512 or exists (
  select 1 from jsonb_to_recordset(p_changes) c(category_id uuid,amount_minor text,expected_version integer)
  group by c.category_id having count(*)>1
 ) then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 for change in select * from jsonb_to_recordset(p_changes) c(category_id uuid,amount_minor text,expected_version integer)
   order by c.category_id nulls first
 loop
  perform public.save_monthly_budget(p_month,change.category_id,change.amount_minor,change.expected_version);
 end loop;
end;
$$;

revoke all on function private.budget_daily_spending(date,date),private.read_budget_workspace(date),
 public.read_budget_workspace(date),public.save_budget_allocations(date,jsonb) from public,anon,authenticated;
grant execute on function private.read_budget_workspace(date),public.read_budget_workspace(date),public.save_budget_allocations(date,jsonb) to authenticated;
