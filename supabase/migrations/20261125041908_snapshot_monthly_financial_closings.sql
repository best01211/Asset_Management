create table public.monthly_financial_closings (
 user_id uuid not null,
 closing_month date not null check(closing_month between date '1900-01-01' and date '9998-12-01' and extract(day from closing_month)=1),
 version integer not null check(version>0),
 snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
 created_at timestamptz not null default now(),
 primary key(user_id,closing_month,version)
);
alter table public.monthly_financial_closings enable row level security;
revoke all on public.monthly_financial_closings from public,anon,authenticated;
grant select on public.monthly_financial_closings to authenticated;
create policy monthly_financial_closings_owner on public.monthly_financial_closings for select to authenticated
 using (user_id=(select auth.uid()));

create trigger monthly_financial_closings_immutable before update or delete on public.monthly_financial_closings
 for each row execute function public.prevent_purchase_reversal_change();
create trigger monthly_financial_closings_no_truncate before truncate on public.monthly_financial_closings
 for each statement execute function public.prevent_purchase_reversal_change();

create function public.calculate_monthly_closing_snapshot(p_month date) returns jsonb
language sql stable set search_path = '' as $$
 with bounds as (
  select (p_month::timestamp at time zone 'Asia/Seoul') as month_start,
   ((p_month+interval '1 month') at time zone 'Asia/Seoul') as month_end
 ), budget as (
  select public.get_monthly_budget(p_month) as details
 ), accounts as (
  select a.id,a.name,a.kind,calculated.balance
  from public.financial_accounts a cross join bounds b
  left join lateral public.calculate_account_balance(a.id,b.month_end-interval '1 microsecond') calculated on true
  where a.user_id=(select auth.uid()) and a.currency='KRW' and a.kind in ('asset','liability')
   and (calculated.balance is not null or exists (
    select 1 from public.ledger_entries e
    join public.transactions t on t.user_id=e.user_id and t.id=e.transaction_id
    where e.user_id=a.user_id and e.account_id=a.id and t.occurred_at<b.month_end
   ))
 )
 select jsonb_build_object(
  'schema_version',1,'period_start',to_char(b.month_start at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'period_end',to_char(b.month_end at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'ledger',public.summarize_confirmed_purchases(p_month),
  'ledger_revision',(
   select md5(coalesce(string_agg(t.id::text,',' order by t.id),''))
   from public.transactions t
   where t.user_id=(select auth.uid()) and t.currency='KRW' and t.occurred_at>=b.month_start and t.occurred_at<b.month_end
  ),
  'budget',jsonb_build_object('total',budget.details->'total','categories',coalesce((
   select jsonb_agg(item order by item->>'category_id')
   from jsonb_array_elements(budget.details->'categories') item
   where item->>'amount_minor' is not null or item->>'spent_minor'<>'0'
  ),'[]'::jsonb)),
  'accounts',coalesce((
   select jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'kind',a.kind,'balance_minor',a.balance::text) order by a.kind,a.id)
   from accounts a
  ),'[]'::jsonb),
  'known_net_assets_minor',(
   select sum(case when a.kind='liability' then -a.balance else a.balance end)::text from accounts a
  ),
  'unknown_balance_count',(select count(*) from accounts a where a.balance is null)
 )
 from bounds b cross join budget;
$$;

create function public.get_monthly_financial_closing(p_month date,p_version integer default null) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
 uid uuid := auth.uid();
 stored public.monthly_financial_closings%rowtype;
 latest integer;
 current_snapshot jsonb;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_month is null or p_month not between date '1900-01-01' and date '9998-12-01' or extract(day from p_month)<>1
  or (p_version is not null and p_version<1) then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 select coalesce(max(c.version),0) into latest from public.monthly_financial_closings c
 where c.user_id=uid and c.closing_month=p_month;
 select * into stored from public.monthly_financial_closings c where c.user_id=uid and c.closing_month=p_month
  and c.version=coalesce(p_version,latest);
 if p_version is not null and not found then raise exception 'CLOSING_VERSION_NOT_FOUND' using errcode='P0002'; end if;
 current_snapshot := public.calculate_monthly_closing_snapshot(p_month);
 return jsonb_build_object('month',to_char(p_month,'YYYY-MM'),'latest_version',latest,
  'saved',case when stored.version is not null then jsonb_build_object(
   'version',stored.version,'created_at',stored.created_at,'snapshot',stored.snapshot) end,
  'current',current_snapshot,
  'changed',case when stored.version is not null then stored.snapshot is distinct from current_snapshot end);
end;
$$;

create function public.save_monthly_financial_closing(p_month date,p_expected_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
 uid uuid := auth.uid();
 latest public.monthly_financial_closings%rowtype;
 next_snapshot jsonb;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_month is null or p_month not between date '1900-01-01' and date '9998-12-01' or extract(day from p_month)<>1
  or p_expected_version is null or p_expected_version<0 then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 if p_month>=date_trunc('month',statement_timestamp() at time zone 'Asia/Seoul')::date then
  raise exception 'CLOSING_MONTH_IN_PROGRESS' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('monthly_closing:'||uid::text||':'||p_month::text,0));
 select * into latest from public.monthly_financial_closings c where c.user_id=uid and c.closing_month=p_month
 order by c.version desc limit 1;
 if coalesce(latest.version,0)<>p_expected_version then raise exception 'CLOSING_VERSION_CONFLICT' using errcode='23505'; end if;
 next_snapshot := public.calculate_monthly_closing_snapshot(p_month);
 if latest.snapshot is distinct from next_snapshot then
  insert into public.monthly_financial_closings(user_id,closing_month,version,snapshot)
  values(uid,p_month,p_expected_version+1,next_snapshot);
 end if;
 return public.get_monthly_financial_closing(p_month,null);
end;
$$;

revoke all on function public.calculate_monthly_closing_snapshot(date) from public,anon;
grant execute on function public.calculate_monthly_closing_snapshot(date) to authenticated;
revoke all on function public.get_monthly_financial_closing(date,integer),
 public.save_monthly_financial_closing(date,integer) from public,anon;
grant execute on function public.get_monthly_financial_closing(date,integer),
 public.save_monthly_financial_closing(date,integer) to authenticated;
