alter table public.transactions drop constraint transactions_source_matches_kind,
 add constraint transactions_source_matches_kind check (
  (kind in ('opening_balance','card_payment','own_transfer','purchase_refund','transfer_fee','balance_adjustment','purchase_reversal')
   and source_pending_id is null)
  or (kind in ('purchase_credit','purchase_debit','purchase_cash') and source_pending_id is not null));

create table public.purchase_reversals (
 user_id uuid not null,
 original_purchase_id uuid not null,
 transaction_id uuid not null,
 reason text not null check (length(reason) between 1 and 200),
 primary key(user_id,original_purchase_id),
 unique(user_id,transaction_id),
 check(original_purchase_id<>transaction_id),
 foreign key(user_id,original_purchase_id) references public.transactions(user_id,id),
 foreign key(user_id,transaction_id) references public.transactions(user_id,id)
);

alter table public.purchase_reversals enable row level security;
revoke all on public.purchase_reversals from public,anon,authenticated;
grant select on public.purchase_reversals to authenticated;
create policy purchase_reversals_owner on public.purchase_reversals for select to authenticated
 using (user_id=(select auth.uid()));

create function public.prevent_purchase_reversal_change() returns trigger
language plpgsql set search_path = '' as $$
begin
 raise exception 'CONFIRMED_LEDGER_IMMUTABLE' using errcode='55000';
end;
$$;
create trigger purchase_reversal_immutable before update or delete on public.purchase_reversals
 for each row execute function public.prevent_purchase_reversal_change();
create trigger purchase_reversal_no_truncate before truncate on public.purchase_reversals
 for each statement execute function public.prevent_purchase_reversal_change();

create function public.reverse_confirmed_purchase(p_purchase_id uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
 uid uuid := auth.uid();
 original record;
 prior public.purchase_reversals%rowtype;
 reason_text text := btrim(p_reason);
 txid uuid;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_purchase_id is null or reason_text is null or length(reason_text) not between 1 and 200 then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;

 -- Refunds take the same original row lock before checking amounts or posting.
 select t.amount_minor,t.currency,t.occurred_at into original
 from public.transactions t where t.user_id=uid and t.id=p_purchase_id and t.currency='KRW'
  and t.kind in ('purchase_credit','purchase_debit','purchase_cash') for update;
 if not found then raise exception 'ORIGINAL_PURCHASE_NOT_FOUND' using errcode='P0002'; end if;

 select * into prior from public.purchase_reversals r where r.user_id=uid and r.original_purchase_id=p_purchase_id;
 if found then
  if prior.reason<>reason_text then raise exception 'PURCHASE_ALREADY_REVERSED' using errcode='23505'; end if;
  return jsonb_build_object('transaction_id',prior.transaction_id,'replayed',true);
 end if;
 if exists (select 1 from public.account_movements m where m.user_id=uid and m.original_purchase_id=p_purchase_id) then
  raise exception 'PURCHASE_HAS_REFUNDS' using errcode='23514';
 end if;

 insert into public.transactions(user_id,kind,amount_minor,currency,merchant,occurred_at)
 values(uid,'purchase_reversal',original.amount_minor,original.currency,'구매 기록 정정',original.occurred_at)
 returning id into txid;
 insert into public.ledger_entries(user_id,transaction_id,account_id,side,amount_minor,currency)
 select uid,txid,e.account_id,case e.side when 'debit' then 'credit' else 'debit' end,e.amount_minor,e.currency
 from public.ledger_entries e where e.user_id=uid and e.transaction_id=p_purchase_id;
 insert into public.purchase_reversals(user_id,original_purchase_id,transaction_id,reason)
 values(uid,p_purchase_id,txid,reason_text);
 return jsonb_build_object('transaction_id',txid,'replayed',false);
end;
$$;
revoke all on function public.reverse_confirmed_purchase(uuid,text) from public,anon;
grant execute on function public.reverse_confirmed_purchase(uuid,text) to authenticated;

create or replace function public.require_open_ledger_posting() returns trigger
language plpgsql set search_path = '' as $$
declare posting_kind text; draft_status text;
begin
 select kind into posting_kind from public.transactions where user_id=new.user_id and id=new.transaction_id;
 if posting_kind in ('opening_balance','card_payment','own_transfer','purchase_refund','transfer_fee','balance_adjustment','purchase_reversal') then
  if tg_table_name='ledger_entries' then
   perform 1 from public.transactions where user_id=new.user_id and id=new.transaction_id for no key update;
   if not exists (select 1 from public.account_opening_balances where user_id=new.user_id and transaction_id=new.transaction_id)
    and not exists (select 1 from public.account_movements where user_id=new.user_id and transaction_id=new.transaction_id)
    and not exists (select 1 from public.purchase_reversals where user_id=new.user_id and transaction_id=new.transaction_id)
    then return new; end if;
  end if;
  raise exception 'CONFIRMED_LEDGER_IMMUTABLE' using errcode='55000';
 end if;

 select p.status into draft_status from public.transactions t join public.pending_transactions p
 on p.user_id=t.user_id and p.id=t.source_pending_id
 where t.user_id=new.user_id and t.id=new.transaction_id for share of p;
 if draft_status is distinct from 'pending_review' then
  raise exception 'CONFIRMED_LEDGER_IMMUTABLE' using errcode='55000';
 end if;
 return new;
end;
$$;

create or replace function public.post_account_movement(
 p_kind text,p_amount_minor text,p_occurred_at timestamptz,p_request_id uuid,
 p_from_account_id uuid default null,p_to_account_id uuid default null,p_original_purchase_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
 uid uuid := auth.uid();
 amount bigint;
 draft record;
 prior record;
 refunded numeric;
 debit_id uuid;
 credit_id uuid;
 txid uuid;
 label text;
 allocations jsonb;
 total_allocated numeric;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_kind is null or p_kind not in ('card_payment','own_transfer','purchase_refund')
  or p_amount_minor is null or p_amount_minor !~ '^[1-9][0-9]{0,18}$'
  or p_occurred_at is null or not isfinite(p_occurred_at) or p_occurred_at>statement_timestamp()
  or p_request_id is null
  or (p_kind='purchase_refund' and (p_original_purchase_id is null or p_from_account_id is not null or p_to_account_id is not null))
  or (p_kind<>'purchase_refund' and (p_original_purchase_id is not null or p_from_account_id is null
   or p_to_account_id is null or p_from_account_id=p_to_account_id)) then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;
 amount := p_amount_minor::bigint;
 perform pg_advisory_xact_lock(hashtextextended('movement:' || uid::text || ':' || p_request_id::text,0));
 select t.id,t.kind,t.occurred_at,t.amount_minor,m.original_purchase_id,m.debit_account_id,m.credit_account_id
 into prior from public.account_movements m join public.transactions t on t.user_id=m.user_id and t.id=m.transaction_id
 where m.user_id=uid and m.request_id=p_request_id;
 if found then
  if prior.kind<>p_kind or prior.occurred_at<>p_occurred_at or prior.amount_minor<>amount
   or prior.original_purchase_id is distinct from p_original_purchase_id
   or (p_kind<>'purchase_refund' and (prior.debit_account_id<>p_to_account_id or prior.credit_account_id<>p_from_account_id)) then
   raise exception 'MOVEMENT_REQUEST_CONFLICT' using errcode='23505';
  end if;
  return jsonb_build_object('transaction_id',prior.id,'replayed',true);
 end if;

 if p_kind='purchase_refund' then
  -- Serialize refunds of the same purchase before checking its remaining refundable amount.
  select t.amount_minor,t.occurred_at into draft from public.transactions t
  where t.user_id=uid and t.id=p_original_purchase_id and t.kind in ('purchase_credit','purchase_debit','purchase_cash')
   and t.currency='KRW' for update;
  if not found then raise exception 'ORIGINAL_PURCHASE_NOT_FOUND' using errcode='P0002'; end if;
  if exists (select 1 from public.purchase_reversals r where r.user_id=uid and r.original_purchase_id=p_original_purchase_id) then
   raise exception 'PURCHASE_ALREADY_REVERSED' using errcode='23514';
  end if;
  if p_occurred_at<draft.occurred_at then raise exception 'REFUND_BEFORE_PURCHASE' using errcode='22023'; end if;
  select coalesce(sum(t.amount_minor),0) into refunded from public.account_movements m
  join public.transactions t on t.user_id=m.user_id and t.id=m.transaction_id and t.kind='purchase_refund'
  where m.user_id=uid and m.original_purchase_id=p_original_purchase_id;
  if refunded+amount>draft.amount_minor then raise exception 'REFUND_EXCEEDS_REMAINING' using errcode='22023'; end if;
  select jsonb_agg(to_jsonb(r) order by r.category_id),sum(r.amount_minor) into allocations,total_allocated
  from public.calculate_purchase_refund_allocations(uid,p_original_purchase_id,amount) r;
  if total_allocated is distinct from amount then raise exception 'REFUND_CATEGORY_UNSUPPORTED' using errcode='22023'; end if;
  select e.account_id into strict debit_id from public.ledger_entries e
  where e.user_id=uid and e.transaction_id=p_original_purchase_id and e.side='credit';
  credit_id := (allocations->0->>'expense_account_id')::uuid;
  label := '구매 환불';
 else
  perform 1 from public.financial_accounts a join public.financial_accounts b on b.user_id=a.user_id
  where a.user_id=uid and a.id=p_from_account_id and b.id=p_to_account_id and a.active and b.active
   and a.currency='KRW' and b.currency='KRW'
   and a.kind='asset' and b.kind=case p_kind when 'card_payment' then 'liability' else 'asset' end;
  if not found then raise exception 'MOVEMENT_ACCOUNT_MISMATCH' using errcode='22023'; end if;
  debit_id := p_to_account_id;
  credit_id := p_from_account_id;
  label := case p_kind when 'card_payment' then '카드 대금 납부' else '본인 계좌 이체' end;
 end if;

 insert into public.transactions(user_id,kind,amount_minor,currency,merchant,occurred_at)
 values(uid,p_kind,amount,'KRW',label,p_occurred_at) returning id into txid;
 if p_kind='purchase_refund' then
  insert into public.refund_allocations(user_id,transaction_id,category_id,expense_account_id,amount_minor)
  select uid,txid,r.category_id,r.expense_account_id,r.amount_minor
  from jsonb_to_recordset(allocations) as r(category_id uuid,expense_account_id uuid,amount_minor bigint);
  insert into public.ledger_entries(user_id,transaction_id,account_id,side,amount_minor,currency)
  select uid,txid,r.expense_account_id,'credit',sum(r.amount_minor)::bigint,'KRW'
  from public.refund_allocations r where r.user_id=uid and r.transaction_id=txid group by r.expense_account_id
  union all select uid,txid,debit_id,'debit',amount,'KRW';
 else
  insert into public.ledger_entries(user_id,transaction_id,account_id,side,amount_minor,currency)
  values(uid,txid,debit_id,'debit',amount,'KRW'),(uid,txid,credit_id,'credit',amount,'KRW');
 end if;
 insert into public.account_movements(user_id,transaction_id,request_id,debit_account_id,credit_account_id,original_purchase_id)
 values(uid,txid,p_request_id,debit_id,credit_id,p_original_purchase_id);
 insert into public.audit_logs(user_id,entity_type,entity_id,action,details)
 values(uid,'transaction',txid,p_kind,jsonb_build_object('original_purchase_id',p_original_purchase_id,'amount_minor',amount::text));
 return jsonb_build_object('transaction_id',txid,'replayed',false);
end;
$$;

create or replace function public.assert_balanced_ledger() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
 txid uuid;
 tx record;
 opening record;
 original_id uuid;
 debit_id uuid;
 credit_id uuid;
 deb numeric;
 cred numeric;
 valid_currency boolean;
 line_count integer;
begin
 if tg_table_name='transactions' then txid := new.id; else txid := new.transaction_id; end if;
 select t.kind,t.currency,t.amount_minor,t.occurred_at,p.status,p.confirmed_transaction_id,p.payment_account_id into tx
 from public.transactions t left join public.pending_transactions p on p.user_id=t.user_id and p.id=t.source_pending_id
 where t.user_id=new.user_id and t.id=txid;
 select sum(e.amount_minor) filter(where e.side='debit'),sum(e.amount_minor) filter(where e.side='credit'),
  bool_and(e.currency=tx.currency and a.currency=tx.currency),count(*)
 into deb,cred,valid_currency,line_count
 from public.ledger_entries e join public.financial_accounts a on a.user_id=e.user_id and a.id=e.account_id
 where e.user_id=new.user_id and e.transaction_id=txid;
 if deb is distinct from tx.amount_minor or cred is distinct from tx.amount_minor or valid_currency is not true then
  raise exception 'LEDGER_UNBALANCED' using errcode='23514';
 end if;

 if tx.kind='purchase_reversal' then
  select p.id into original_id from public.purchase_reversals r join public.transactions p
   on p.user_id=r.user_id and p.id=r.original_purchase_id
   where r.user_id=new.user_id and r.transaction_id=txid
    and p.kind in ('purchase_credit','purchase_debit','purchase_cash')
    and p.occurred_at=tx.occurred_at and p.amount_minor=tx.amount_minor and p.currency=tx.currency
    and not exists (select 1 from public.account_movements m
     where m.user_id=r.user_id and m.original_purchase_id=p.id);
  if not found or line_count<>(select count(*) from public.ledger_entries e where e.user_id=new.user_id and e.transaction_id=original_id)
   or exists (
    select e.account_id,e.side,e.amount_minor from public.ledger_entries e where e.user_id=new.user_id and e.transaction_id=txid
    except all
    select e.account_id,case e.side when 'debit' then 'credit' else 'debit' end,e.amount_minor
    from public.ledger_entries e where e.user_id=new.user_id and e.transaction_id=original_id
   ) then
   raise exception 'LEDGER_UNBALANCED' using errcode='23514';
  end if;
  return null;
 elsif tx.kind='opening_balance' then
  select b.account_id,b.equity_account_id,b.amount_minor,b.effective_at,a.kind into opening
  from public.account_opening_balances b
  join public.financial_accounts a on a.user_id=b.user_id and a.id=b.account_id
  join public.financial_accounts eq on eq.user_id=b.user_id and eq.id=b.equity_account_id and eq.kind='equity'
  where b.user_id=new.user_id and b.transaction_id=txid;
  if not found or opening.kind not in ('asset','liability')
   or tx.currency<>'KRW' or opening.amount_minor<>tx.amount_minor or opening.effective_at<>tx.occurred_at then
   raise exception 'LEDGER_UNBALANCED' using errcode='23514';
  end if;
  debit_id := case opening.kind when 'asset' then opening.account_id else opening.equity_account_id end;
  credit_id := case opening.kind when 'asset' then opening.equity_account_id else opening.account_id end;
 elsif tx.kind in ('card_payment','own_transfer','purchase_refund','transfer_fee','balance_adjustment') then
  select m.debit_account_id,m.credit_account_id into debit_id,credit_id
  from public.account_movements m
  join public.financial_accounts d on d.user_id=m.user_id and d.id=m.debit_account_id
  join public.financial_accounts c on c.user_id=m.user_id and c.id=m.credit_account_id
  where m.user_id=new.user_id and m.transaction_id=txid and tx.currency='KRW' and (
   (tx.kind='card_payment' and d.kind='liability' and c.kind='asset' and m.original_purchase_id is null)
   or (tx.kind='own_transfer' and d.kind='asset' and c.kind='asset' and m.original_purchase_id is null)
   or (tx.kind='transfer_fee' and d.kind='expense' and c.kind='asset' and m.original_purchase_id is null
    and exists (
     select 1 from public.transfer_fees f
     join public.account_movements transfer on transfer.user_id=f.user_id and transfer.transaction_id=f.transfer_id
     join public.transactions original on original.user_id=transfer.user_id and original.id=transfer.transaction_id
     join public.categories category on category.user_id=f.user_id and category.id=f.category_id
     where f.user_id=m.user_id and f.transaction_id=m.transaction_id
      and original.kind='own_transfer' and original.occurred_at=tx.occurred_at
      and transfer.credit_account_id=c.id and category.expense_account_id=d.id))
   or (tx.kind='balance_adjustment' and m.original_purchase_id is null
    and exists (
     select 1 from public.balance_adjustments adjustment
     join public.account_balance_checks check_row on check_row.user_id=adjustment.user_id and check_row.id=adjustment.balance_check_id
     where adjustment.user_id=m.user_id and adjustment.transaction_id=m.transaction_id
      and check_row.observed_at=tx.occurred_at
      and abs(check_row.actual_minor-check_row.ledger_minor)=tx.amount_minor
      and (d.id=check_row.account_id and c.kind='equity'
       and ((d.kind='asset' and check_row.actual_minor>check_row.ledger_minor)
        or (d.kind='liability' and check_row.actual_minor<check_row.ledger_minor))
       or c.id=check_row.account_id and d.kind='equity'
       and ((c.kind='liability' and check_row.actual_minor>check_row.ledger_minor)
        or (c.kind='asset' and check_row.actual_minor<check_row.ledger_minor)))))
   or (tx.kind='purchase_refund' and d.kind in ('asset','liability') and c.kind='expense'
    and exists (select 1 from public.transactions p
     join public.ledger_entries payout on payout.user_id=p.user_id and payout.transaction_id=p.id
      and payout.side='credit' and payout.account_id=d.id
     join public.ledger_entries spend on spend.user_id=p.user_id and spend.transaction_id=p.id
      and spend.side='debit' and spend.account_id=c.id
     where p.user_id=m.user_id and p.id=m.original_purchase_id and p.currency='KRW'
      and p.kind in ('purchase_credit','purchase_debit','purchase_cash') and p.occurred_at<=tx.occurred_at))
  );
  if not found then raise exception 'LEDGER_UNBALANCED' using errcode='23514'; end if;
  if tx.kind='purchase_refund' then
   if not public.posted_category_entries_match(new.user_id,txid,'credit')
    or not exists (select 1 from public.ledger_entries e where e.user_id=new.user_id and e.transaction_id=txid
     and e.side='debit' and e.account_id=debit_id and e.amount_minor=tx.amount_minor)
    or exists (
     select 1 from public.refund_allocations r join public.account_movements m
      on m.user_id=r.user_id and m.transaction_id=r.transaction_id
     where r.user_id=new.user_id and r.transaction_id=txid and not exists (
      select 1 from public.transaction_splits s join public.categories c on c.user_id=s.user_id and c.id=s.category_id
      where s.user_id=r.user_id and s.transaction_id=m.original_purchase_id and s.category_id=r.category_id
       and coalesce(s.expense_account_id,c.expense_account_id)=r.expense_account_id and s.amount_minor>=r.amount_minor
     )
    ) then raise exception 'LEDGER_UNBALANCED' using errcode='23514'; end if;
   return null;
  end if;
 else
  if tx.status is distinct from 'confirmed' or tx.confirmed_transaction_id is distinct from txid
   or not public.posted_category_entries_match(new.user_id,txid,'debit')
   or not exists (select 1 from public.ledger_entries e where e.user_id=new.user_id and e.transaction_id=txid
    and e.side='credit' and e.account_id=tx.payment_account_id and e.amount_minor=tx.amount_minor) then
   raise exception 'LEDGER_UNBALANCED' using errcode='23514';
  end if;
  return null;
 end if;

 if line_count<>2
  or not exists (select 1 from public.ledger_entries where user_id=new.user_id and transaction_id=txid and side='debit' and account_id=debit_id)
  or not exists (select 1 from public.ledger_entries where user_id=new.user_id and transaction_id=txid and side='credit' and account_id=credit_id)
  then raise exception 'LEDGER_UNBALANCED' using errcode='23514'; end if;
 return null;
end;
$$;

create or replace function public.summarize_confirmed_purchases(p_month date) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
 uid uuid := auth.uid();
 period_start timestamptz;
 period_end timestamptz;
 summary jsonb;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_month is null or p_month not between date '1900-01-01' and date '9998-12-01' or extract(day from p_month)<>1
  then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 period_start := p_month::timestamp at time zone 'Asia/Seoul';
 period_end := (p_month+interval '1 month') at time zone 'Asia/Seoul';

 with activity as materialized (
  select t.id,t.kind,t.amount_minor,
   exists (select 1 from public.purchase_reversals r where r.user_id=uid and r.original_purchase_id=t.id) as reversed
  from public.transactions t where t.user_id=uid and t.currency='KRW'
   and t.kind<>'opening_balance' and t.occurred_at>=period_start and t.occurred_at<period_end
 ), spending as (
  select a.id as purchase_id,null::bigint as refund_minor from activity a
   where a.kind in ('purchase_credit','purchase_debit','purchase_cash') and not a.reversed
  union all
  select m.original_purchase_id,a.amount_minor from activity a
  join public.account_movements m on m.user_id=uid and m.transaction_id=a.id
  where a.kind='purchase_refund' and not exists (
   select 1 from public.refund_allocations r where r.user_id=uid and r.transaction_id=a.id
  )
 ), category_amounts as (
  select s.category_id,case when p.refund_minor is null then s.amount_minor else -p.refund_minor end as amount_minor
  from spending p join public.transaction_splits s on s.user_id=uid and s.transaction_id=p.purchase_id
  union all
  select r.category_id,-r.amount_minor from activity a
  join public.refund_allocations r on r.user_id=uid and r.transaction_id=a.id where a.kind='purchase_refund'
  union all
  select f.category_id,a.amount_minor from activity a
  join public.transfer_fees f on f.user_id=uid and f.transaction_id=a.id where a.kind='transfer_fee'
 ), categories as (
  select c.id,c.name,sum(items.amount_minor)::text as amount_minor
  from category_amounts items join public.categories c on c.user_id=uid and c.id=items.category_id
  group by c.id,c.name
 ), accounts as (
  select a.id,a.name,a.kind,sum(case when (a.kind='asset' and e.side='debit') or (a.kind='liability' and e.side='credit')
   then e.amount_minor else -e.amount_minor end)::text as change_minor
  from activity p join public.ledger_entries e on e.user_id=uid and e.transaction_id=p.id
  join public.financial_accounts a on a.user_id=uid and a.id=e.account_id
  where a.kind in ('asset','liability') and a.currency='KRW' group by a.id,a.name,a.kind
 ), totals as (
  select count(*) filter(where a.kind in ('purchase_credit','purchase_debit','purchase_cash') and not a.reversed) as purchase_count,
   coalesce(sum(a.amount_minor) filter(where a.kind in ('purchase_credit','purchase_debit','purchase_cash') and not a.reversed),0) as gross,
   coalesce(sum(a.amount_minor) filter(where a.kind='purchase_refund'),0) as refunds,
   coalesce(sum(a.amount_minor) filter(where a.kind='transfer_fee'),0) as fees
  from activity a
 )
 select jsonb_build_object('month',to_char(p_month,'YYYY-MM'),'currency','KRW',
  'purchase_count',t.purchase_count,'spending_minor',(t.gross+t.fees-t.refunds)::text,
  'gross_spending_minor',t.gross::text,'refund_minor',t.refunds::text,'fee_minor',t.fees::text,
  'categories',coalesce((select jsonb_agg(to_jsonb(c) order by c.name,c.id) from categories c),'[]'::jsonb),
  'accounts',coalesce((select jsonb_agg(to_jsonb(a) order by a.kind,a.name,a.id) from accounts a),'[]'::jsonb))
 into summary from totals t;
 return summary;
end;
$$;

create or replace function public.get_purchase_refund_details(p_transaction_id uuid) returns jsonb
language sql stable set search_path = '' as $$
 select jsonb_build_object('id',p.id,'merchant',p.merchant,'amount_minor',p.amount_minor::text,
  'occurred_at',p.occurred_at,
  'remaining_minor',case when reversal.transaction_id is null then (p.amount_minor-coalesce(refunded.amount,0))::text else '0' end,
  'reversal_id',reversal.transaction_id,'reversal_reason',reversal.reason,
  'has_refunds',coalesce(refunded.amount,0)>0,
  'allocations',coalesce((
   select jsonb_agg(jsonb_build_object('category_id',c.id,'name',c.name,'amount_minor',s.amount_minor::text) order by c.name,c.id)
   from public.transaction_splits s join public.categories c on c.user_id=s.user_id and c.id=s.category_id
   where s.user_id=p.user_id and s.transaction_id=p.id
  ),'[]'::jsonb))
 from public.transactions p
 left join public.purchase_reversals reversal on reversal.user_id=p.user_id and reversal.original_purchase_id=p.id
 left join lateral (
  select sum(t.amount_minor) as amount from public.account_movements m
  join public.transactions t on t.user_id=m.user_id and t.id=m.transaction_id and t.kind='purchase_refund'
  where m.user_id=p.user_id and m.original_purchase_id=p.id
 ) refunded on true
 where p.user_id=(select auth.uid()) and p.id=p_transaction_id and p.currency='KRW'
  and p.kind in ('purchase_credit','purchase_debit','purchase_cash')
$$;

create or replace function public.get_monthly_ledger_export(p_month date,p_kind text) returns jsonb
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
   t.source_pending_id,coalesce(m.original_purchase_id,reversal.original_purchase_id),fee.transfer_id,adjustment.balance_check_id)
   order by t.occurred_at,t.id) into exported
  from public.transactions t
  left join public.account_movements m on m.user_id=t.user_id and m.transaction_id=t.id
  left join public.purchase_reversals reversal on reversal.user_id=t.user_id and reversal.transaction_id=t.id
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
