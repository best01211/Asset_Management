create index transactions_owner_currency_date_idx on public.transactions(user_id,currency,occurred_at);

create function public.summarize_confirmed_purchases(p_month date) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
 uid uuid := auth.uid();
 period_start timestamptz;
 period_end timestamptz;
 summary jsonb;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_month is null or p_month not between date '1900-01-01' and date '9998-12-01'
  or extract(day from p_month)<>1 then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;
 period_start := p_month::timestamp at time zone 'Asia/Seoul';
 period_end := (p_month + interval '1 month') at time zone 'Asia/Seoul';

 with purchases as materialized (
  select t.id,t.amount_minor from public.transactions t
  where t.user_id=uid and t.currency='KRW'
   and t.kind in ('purchase_credit','purchase_debit','purchase_cash')
   and t.occurred_at>=period_start and t.occurred_at<period_end
 ), categories as (
  select c.id,c.name,sum(s.amount_minor)::text as amount_minor
  from purchases p join public.transaction_splits s on s.user_id=uid and s.transaction_id=p.id
  join public.categories c on c.user_id=uid and c.id=s.category_id
  group by c.id,c.name
 ), accounts as (
  select a.id,a.name,a.kind,
   sum(case when (a.kind='asset' and e.side='debit') or (a.kind='liability' and e.side='credit')
     then e.amount_minor else -e.amount_minor end)::text as change_minor
  from purchases p join public.ledger_entries e on e.user_id=uid and e.transaction_id=p.id
  join public.financial_accounts a on a.user_id=uid and a.id=e.account_id
  where a.kind in ('asset','liability') and a.currency='KRW'
  group by a.id,a.name,a.kind
 )
 select jsonb_build_object(
  'month',to_char(p_month,'YYYY-MM'),'currency','KRW',
  'purchase_count',(select count(*) from purchases),
  'spending_minor',(select coalesce(sum(p.amount_minor),0)::text from purchases p),
  'categories',coalesce((select jsonb_agg(to_jsonb(c) order by c.name,c.id) from categories c),'[]'::jsonb),
  'accounts',coalesce((select jsonb_agg(to_jsonb(a) order by a.kind,a.name,a.id) from accounts a),'[]'::jsonb))
 into summary;
 return summary;
end;
$$;

revoke all on function public.summarize_confirmed_purchases(date) from public,anon;
grant execute on function public.summarize_confirmed_purchases(date) to authenticated;
