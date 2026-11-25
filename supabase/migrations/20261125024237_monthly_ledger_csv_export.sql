create function public.get_monthly_ledger_export(p_month date,p_kind text) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
 uid uuid := auth.uid();
 period_start timestamptz;
 period_end timestamptz;
 exported jsonb;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_month is null or p_month not between date '1900-01-01' and date '9998-12-01'
  or extract(day from p_month)<>1 or p_kind is null or p_kind not in ('transactions','entries') then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;
 period_start := p_month::timestamp at time zone 'Asia/Seoul';
 period_end := (p_month+interval '1 month') at time zone 'Asia/Seoul';

 if p_kind='transactions' then
  select jsonb_agg(jsonb_build_array(t.id,t.kind,t.merchant,t.amount_minor::text,t.currency,
   to_char(t.occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
   t.source_pending_id,m.original_purchase_id,fee.transfer_id,adjustment.balance_check_id)
   order by t.occurred_at,t.id) into exported
  from public.transactions t
  left join public.account_movements m on m.user_id=t.user_id and m.transaction_id=t.id
  left join public.transfer_fees fee on fee.user_id=t.user_id and fee.transaction_id=t.id
  left join public.balance_adjustments adjustment on adjustment.user_id=t.user_id and adjustment.transaction_id=t.id
  where t.user_id=uid and t.occurred_at>=period_start and t.occurred_at<period_end;
 else
  select jsonb_agg(jsonb_build_array(e.id,t.id,t.kind,e.account_id,a.name,e.side,e.amount_minor::text,e.currency,
   to_char(t.occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
   order by t.occurred_at,t.id,e.side,e.id) into exported
  from public.transactions t
  join public.ledger_entries e on e.user_id=t.user_id and e.transaction_id=t.id
  join public.financial_accounts a on a.user_id=e.user_id and a.id=e.account_id
  where t.user_id=uid and t.occurred_at>=period_start and t.occurred_at<period_end;
 end if;
 return coalesce(exported,'[]'::jsonb);
end;
$$;

revoke all on function public.get_monthly_ledger_export(date,text) from public,anon;
grant execute on function public.get_monthly_ledger_export(date,text) to authenticated;
