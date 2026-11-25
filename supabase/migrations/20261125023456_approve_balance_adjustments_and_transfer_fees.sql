alter table public.transactions drop constraint transactions_source_matches_kind,
 add constraint transactions_source_matches_kind check (
  (kind in ('opening_balance','card_payment','own_transfer','purchase_refund','transfer_fee','balance_adjustment') and source_pending_id is null)
  or (kind in ('purchase_credit','purchase_debit','purchase_cash') and source_pending_id is not null));

alter table public.account_balance_checks
 add constraint account_balance_check_owner_key unique (user_id,id);

create table public.balance_adjustments (
 user_id uuid not null,
 balance_check_id uuid not null,
 transaction_id uuid not null,
 primary key(user_id,balance_check_id),
 unique(user_id,transaction_id),
 foreign key(user_id,balance_check_id) references public.account_balance_checks(user_id,id),
 foreign key(user_id,transaction_id) references public.account_movements(user_id,transaction_id)
);

create table public.transfer_fees (
 user_id uuid not null,
 transfer_id uuid not null,
 transaction_id uuid not null,
 category_id uuid not null,
 primary key(user_id,transfer_id),
 unique(user_id,transaction_id),
 foreign key(user_id,transfer_id) references public.account_movements(user_id,transaction_id),
 foreign key(user_id,transaction_id) references public.account_movements(user_id,transaction_id),
 foreign key(user_id,category_id) references public.categories(user_id,id),
 check (transfer_id<>transaction_id)
);

alter table public.balance_adjustments enable row level security;
alter table public.transfer_fees enable row level security;
revoke all on public.balance_adjustments,public.transfer_fees from public,anon,authenticated;
grant select on public.balance_adjustments,public.transfer_fees to authenticated;
create policy balance_adjustments_owner_read on public.balance_adjustments for select to authenticated
 using ((select auth.uid())=user_id);
create policy transfer_fees_owner_read on public.transfer_fees for select to authenticated
 using ((select auth.uid())=user_id);
create trigger balance_adjustment_immutable before update or delete on public.balance_adjustments
 for each row execute function public.reject_ledger_mutation();
create trigger balance_adjustment_no_truncate before truncate on public.balance_adjustments
 for each statement execute function public.reject_ledger_mutation();
create trigger transfer_fee_immutable before update or delete on public.transfer_fees
 for each row execute function public.reject_ledger_mutation();
create trigger transfer_fee_no_truncate before truncate on public.transfer_fees
 for each statement execute function public.reject_ledger_mutation();

create or replace function public.require_open_ledger_posting() returns trigger
language plpgsql set search_path = '' as $$
declare posting_kind text; draft_status text;
begin
 select kind into posting_kind from public.transactions where user_id=new.user_id and id=new.transaction_id;
 if posting_kind in ('opening_balance','card_payment','own_transfer','purchase_refund','transfer_fee','balance_adjustment') then
  if tg_table_name='ledger_entries' then
   perform 1 from public.transactions where user_id=new.user_id and id=new.transaction_id for no key update;
   if not exists (select 1 from public.account_opening_balances where user_id=new.user_id and transaction_id=new.transaction_id)
    and not exists (select 1 from public.account_movements where user_id=new.user_id and transaction_id=new.transaction_id)
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

create or replace function public.assert_balanced_ledger() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
 txid uuid;
 tx record;
 opening record;
 debit_id uuid;
 credit_id uuid;
 deb numeric;
 cred numeric;
 valid_currency boolean;
 line_count integer;
begin
 if tg_table_name='transactions' then txid := new.id; else txid := new.transaction_id; end if;
 select t.kind,t.currency,t.amount_minor,t.occurred_at,p.status,p.confirmed_transaction_id into tx
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

 if tx.kind='opening_balance' then
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
 else
  if tx.status is distinct from 'confirmed' or tx.confirmed_transaction_id is distinct from txid then
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

-- Internal writer. The calling RPC also records the origin before deferred validation.
create function public.post_derived_account_entry(
 p_user_id uuid,p_kind text,p_amount bigint,p_at timestamptz,p_debit_account_id uuid,p_credit_account_id uuid,p_label text
) returns uuid
language plpgsql set search_path = '' as $$
declare txid uuid;
begin
 insert into public.transactions(user_id,kind,amount_minor,currency,merchant,occurred_at)
 values(p_user_id,p_kind,p_amount,'KRW',p_label,p_at) returning id into txid;
 insert into public.ledger_entries(user_id,transaction_id,account_id,side,amount_minor,currency)
 values(p_user_id,txid,p_debit_account_id,'debit',p_amount,'KRW'),
  (p_user_id,txid,p_credit_account_id,'credit',p_amount,'KRW');
 insert into public.account_movements(user_id,transaction_id,request_id,debit_account_id,credit_account_id)
 values(p_user_id,txid,gen_random_uuid(),p_debit_account_id,p_credit_account_id);
 return txid;
end;
$$;
revoke all on function public.post_derived_account_entry(uuid,text,bigint,timestamptz,uuid,uuid,text)
 from public,anon,authenticated;

create function public.post_own_transfer_with_fee(
 p_amount_minor text,p_occurred_at timestamptz,p_request_id uuid,p_from_account_id uuid,p_to_account_id uuid,
 p_fee_minor text default '0',p_fee_category_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
 uid uuid := auth.uid();
 principal jsonb;
 transfer_id uuid;
 fee_id uuid;
 fee_amount bigint;
 expense_id uuid;
 previous record;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_fee_minor is null or p_fee_minor !~ '^(0|[1-9][0-9]{0,18})$'
  or (p_fee_minor='0')<>(p_fee_category_id is null) then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;
 fee_amount := p_fee_minor::bigint;

 -- Nested RPC holds the principal request lock for the duration of this transaction.
 principal := public.post_account_movement('own_transfer',p_amount_minor,p_occurred_at,p_request_id,p_from_account_id,p_to_account_id);
 transfer_id := (principal->>'transaction_id')::uuid;
 if (principal->>'replayed')::boolean then
  select f.transaction_id,f.category_id,t.amount_minor into previous
  from public.transfer_fees f join public.transactions t on t.user_id=f.user_id and t.id=f.transaction_id
  where f.user_id=uid and f.transfer_id=(principal->>'transaction_id')::uuid;
  if not found and fee_amount=0 then return principal || jsonb_build_object('fee_transaction_id',null); end if;
  if not found or previous.amount_minor<>fee_amount or previous.category_id is distinct from p_fee_category_id then
   raise exception 'MOVEMENT_REQUEST_CONFLICT' using errcode='23505';
  end if;
  return principal || jsonb_build_object('fee_transaction_id',previous.transaction_id);
 end if;

 if fee_amount>0 then
  select a.id into expense_id from public.categories c join public.financial_accounts a
   on a.user_id=c.user_id and a.id=c.expense_account_id
  where c.user_id=uid and c.id=p_fee_category_id and a.kind='expense' and a.currency='KRW';
  if not found then raise exception 'FEE_CATEGORY_INVALID' using errcode='22023'; end if;
  fee_id := public.post_derived_account_entry(uid,'transfer_fee',fee_amount,p_occurred_at,expense_id,p_from_account_id,'이체 수수료');
  insert into public.transfer_fees(user_id,transfer_id,transaction_id,category_id)
  values(uid,transfer_id,fee_id,p_fee_category_id);
  insert into public.audit_logs(user_id,entity_type,entity_id,action,details)
  values(uid,'transaction',fee_id,'transfer_fee',jsonb_build_object('transfer_id',transfer_id,'amount_minor',fee_amount::text));
 end if;
 return principal || jsonb_build_object('fee_transaction_id',fee_id);
end;
$$;

create function public.approve_balance_adjustment(p_balance_check_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
 uid uuid := auth.uid();
 comparison public.account_balance_checks%rowtype;
 account_row public.financial_accounts%rowtype;
 calculated numeric;
 difference numeric;
 txid uuid;
 equity_id uuid;
 account_is_debit boolean;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 select * into comparison from public.account_balance_checks
 where user_id=uid and id=p_balance_check_id for update;
 if not found then raise exception 'BALANCE_CHECK_NOT_FOUND' using errcode='P0002'; end if;
 select transaction_id into txid from public.balance_adjustments where user_id=uid and balance_check_id=p_balance_check_id;
 if found then return jsonb_build_object('transaction_id',txid,'replayed',true); end if;

 select * into account_row from public.financial_accounts
 where user_id=uid and id=comparison.account_id for update;
 select balance into calculated from public.calculate_account_balance(comparison.account_id,comparison.observed_at);
 if calculated is distinct from comparison.ledger_minor or exists (
  select 1 from public.balance_adjustments adjustment
  join public.account_balance_checks prior on prior.user_id=adjustment.user_id and prior.id=adjustment.balance_check_id
  where prior.user_id=uid and prior.account_id=comparison.account_id and prior.observed_at>comparison.observed_at
 ) then
  raise exception 'BALANCE_CHECK_STALE' using errcode='P0001';
 end if;
 difference := comparison.actual_minor-calculated;
 if difference=0 then raise exception 'NO_BALANCE_DIFFERENCE' using errcode='22023'; end if;
 if abs(difference)>9223372036854775807 then raise exception 'ADJUSTMENT_AMOUNT_OUT_OF_RANGE' using errcode='22023'; end if;

 insert into public.financial_accounts(user_id,name,kind,currency)
 values(uid,'잔액 조정 상계','equity','KRW') returning id into equity_id;
 account_is_debit := (account_row.kind='asset' and difference>0) or (account_row.kind='liability' and difference<0);
 txid := public.post_derived_account_entry(uid,'balance_adjustment',abs(difference)::bigint,comparison.observed_at,
  case when account_is_debit then comparison.account_id else equity_id end,
  case when account_is_debit then equity_id else comparison.account_id end,'잔액 차액 조정');
 insert into public.balance_adjustments(user_id,balance_check_id,transaction_id) values(uid,p_balance_check_id,txid);
 insert into public.audit_logs(user_id,entity_type,entity_id,action,details)
 values(uid,'transaction',txid,'balance_adjustment',jsonb_build_object(
  'balance_check_id',p_balance_check_id,'difference_minor',difference::text));
 return jsonb_build_object('transaction_id',txid,'replayed',false);
end;
$$;

drop function public.list_account_balance_checks(integer);
create function public.list_account_balance_checks(p_limit integer default 30) returns table (
 id uuid,account_name text,observed_at timestamptz,actual_minor text,ledger_minor text,difference_minor text,
 adjustment_transaction_id uuid
)
language sql stable set search_path = '' as $$
 select b.id,a.name,b.observed_at,b.actual_minor::text,b.ledger_minor::text,(b.actual_minor-b.ledger_minor)::text,
  adjustment.transaction_id
 from public.account_balance_checks b
 join public.financial_accounts a on a.user_id=b.user_id and a.id=b.account_id
 left join public.balance_adjustments adjustment on adjustment.user_id=b.user_id and adjustment.balance_check_id=b.id
 where b.user_id=(select auth.uid()) order by b.observed_at desc,b.id desc limit greatest(0,least(coalesce(p_limit,30),100))
$$;

revoke all on function public.post_own_transfer_with_fee(text,timestamptz,uuid,uuid,uuid,text,uuid) from public,anon;
revoke all on function public.approve_balance_adjustment(uuid) from public,anon;
revoke all on function public.list_account_balance_checks(integer) from public,anon;
grant execute on function public.post_own_transfer_with_fee(text,timestamptz,uuid,uuid,uuid,text,uuid) to authenticated;
grant execute on function public.approve_balance_adjustment(uuid) to authenticated;
grant execute on function public.list_account_balance_checks(integer) to authenticated;

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
  select t.id,t.kind,t.amount_minor from public.transactions t where t.user_id=uid and t.currency='KRW'
   and t.kind<>'opening_balance' and t.occurred_at>=period_start and t.occurred_at<period_end
 ), spending as (
  select a.id as purchase_id,null::bigint as refund_minor from activity a
   where a.kind in ('purchase_credit','purchase_debit','purchase_cash')
  union all
  select m.original_purchase_id,a.amount_minor from activity a
  join public.account_movements m on m.user_id=uid and m.transaction_id=a.id
  where a.kind='purchase_refund'
 ), category_amounts as (
  select s.category_id,case when p.refund_minor is null then s.amount_minor else -p.refund_minor end as amount_minor
  from spending p join public.transaction_splits s on s.user_id=uid and s.transaction_id=p.purchase_id
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
  select count(*) filter(where a.kind in ('purchase_credit','purchase_debit','purchase_cash')) as purchase_count,
   coalesce(sum(a.amount_minor) filter(where a.kind in ('purchase_credit','purchase_debit','purchase_cash')),0) as gross,
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
