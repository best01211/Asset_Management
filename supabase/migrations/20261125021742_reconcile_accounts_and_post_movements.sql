alter table public.transactions drop constraint transactions_source_matches_kind,
 add constraint transactions_source_matches_kind check (
   (kind in ('opening_balance','card_payment','own_transfer','purchase_refund') and source_pending_id is null)
   or (kind in ('purchase_credit','purchase_debit','purchase_cash') and source_pending_id is not null));

create table public.account_movements (
 user_id uuid not null,
 transaction_id uuid not null,
 request_id uuid not null,
 debit_account_id uuid not null,
 credit_account_id uuid not null,
 original_purchase_id uuid,
 primary key (user_id,transaction_id),
 unique (user_id,request_id),
 foreign key (user_id,transaction_id) references public.transactions(user_id,id),
 foreign key (user_id,debit_account_id) references public.financial_accounts(user_id,id),
 foreign key (user_id,credit_account_id) references public.financial_accounts(user_id,id),
 foreign key (user_id,original_purchase_id) references public.transactions(user_id,id),
 check (debit_account_id<>credit_account_id)
);

create index account_movements_refund_idx on public.account_movements(user_id,original_purchase_id)
 where original_purchase_id is not null;

create table public.account_balance_checks (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null,
 account_id uuid not null,
 request_id uuid not null,
 observed_at timestamptz not null check (isfinite(observed_at)),
 actual_minor bigint not null,
 ledger_minor numeric not null,
 created_at timestamptz not null default now(),
 unique(user_id,request_id),
 foreign key(user_id,account_id) references public.financial_accounts(user_id,id)
);
create index account_balance_checks_owner_idx on public.account_balance_checks(user_id,observed_at desc,id desc);

alter table public.account_movements enable row level security;
alter table public.account_balance_checks enable row level security;
revoke all on public.account_movements,public.account_balance_checks from public,anon,authenticated;
grant select on public.account_movements,public.account_balance_checks to authenticated;
create policy account_movements_owner_read on public.account_movements for select to authenticated
 using ((select auth.uid())=user_id);
create policy account_balance_checks_owner_read on public.account_balance_checks for select to authenticated
 using ((select auth.uid())=user_id);
create trigger account_movement_immutable before update or delete on public.account_movements
 for each row execute function public.reject_ledger_mutation();
create trigger account_movement_no_truncate before truncate on public.account_movements
 for each statement execute function public.reject_ledger_mutation();
create trigger account_check_immutable before update or delete on public.account_balance_checks
 for each row execute function public.reject_ledger_mutation();
create trigger account_check_no_truncate before truncate on public.account_balance_checks
 for each statement execute function public.reject_ledger_mutation();

create or replace function public.require_open_ledger_posting() returns trigger
language plpgsql set search_path = '' as $$
declare posting_kind text; draft_status text;
begin
 select kind into posting_kind from public.transactions where user_id=new.user_id and id=new.transaction_id;
 if posting_kind in ('opening_balance','card_payment','own_transfer','purchase_refund') then
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
 elsif tx.kind in ('card_payment','own_transfer','purchase_refund') then
  select m.debit_account_id,m.credit_account_id into debit_id,credit_id
  from public.account_movements m
  join public.financial_accounts d on d.user_id=m.user_id and d.id=m.debit_account_id
  join public.financial_accounts c on c.user_id=m.user_id and c.id=m.credit_account_id
  where m.user_id=new.user_id and m.transaction_id=txid and tx.currency='KRW' and (
   (tx.kind='card_payment' and d.kind='liability' and c.kind='asset' and m.original_purchase_id is null)
   or (tx.kind='own_transfer' and d.kind='asset' and c.kind='asset' and m.original_purchase_id is null)
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

create function public.post_account_movement(
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
  if p_occurred_at<draft.occurred_at then raise exception 'REFUND_BEFORE_PURCHASE' using errcode='22023'; end if;
  select coalesce(sum(t.amount_minor),0) into refunded from public.account_movements m
  join public.transactions t on t.user_id=m.user_id and t.id=m.transaction_id and t.kind='purchase_refund'
  where m.user_id=uid and m.original_purchase_id=p_original_purchase_id;
  if refunded+amount>draft.amount_minor then raise exception 'REFUND_EXCEEDS_REMAINING' using errcode='22023'; end if;
  if not exists (
   select 1 from public.transaction_splits s where s.user_id=uid and s.transaction_id=p_original_purchase_id
   group by s.transaction_id having count(*)=1 and sum(s.amount_minor)=draft.amount_minor
  ) then raise exception 'REFUND_CATEGORY_UNSUPPORTED' using errcode='22023'; end if;
  select e.account_id into strict debit_id from public.ledger_entries e
  where e.user_id=uid and e.transaction_id=p_original_purchase_id and e.side='credit';
  select e.account_id into strict credit_id from public.ledger_entries e
  where e.user_id=uid and e.transaction_id=p_original_purchase_id and e.side='debit';
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
 insert into public.ledger_entries(user_id,transaction_id,account_id,side,amount_minor,currency)
 values(uid,txid,debit_id,'debit',amount,'KRW'),(uid,txid,credit_id,'credit',amount,'KRW');
 insert into public.account_movements(user_id,transaction_id,request_id,debit_account_id,credit_account_id,original_purchase_id)
 values(uid,txid,p_request_id,debit_id,credit_id,p_original_purchase_id);
 insert into public.audit_logs(user_id,entity_type,entity_id,action,details)
 values(uid,'transaction',txid,p_kind,jsonb_build_object('original_purchase_id',p_original_purchase_id,'amount_minor',amount::text));
 return jsonb_build_object('transaction_id',txid,'replayed',false);
end;
$$;

-- Return a point-in-time balance with the same cutoff used for opening balances.
create function public.calculate_account_balance(p_account_id uuid,p_at timestamptz)
returns table (purchase_change numeric,ledger_change numeric,balance numeric)
language sql stable set search_path = '' as $$
 select coalesce(sum(changes.impact) filter(where changes.kind in ('purchase_credit','purchase_debit','purchase_cash')),0),
  coalesce(sum(changes.impact),0),b.amount_minor+coalesce(sum(changes.impact),0)
 from public.account_opening_balances b
 join public.financial_accounts a on a.user_id=b.user_id and a.id=b.account_id
 left join lateral (
  select case when (a.kind='asset' and e.side='debit') or (a.kind='liability' and e.side='credit')
   then e.amount_minor else -e.amount_minor end as impact,t.kind
  from public.ledger_entries e join public.transactions t on t.user_id=e.user_id and t.id=e.transaction_id
  where e.user_id=a.user_id and e.account_id=a.id and t.currency='KRW' and t.kind<>'opening_balance'
   and t.occurred_at>=b.effective_at and t.occurred_at<=p_at
 ) changes on true
 where b.user_id=(select auth.uid()) and b.account_id=p_account_id and b.effective_at<=p_at
 group by b.amount_minor;
$$;

drop function public.list_account_balances();
create function public.list_account_balances()
returns table (id uuid,name text,kind text,opening_amount_minor text,opening_effective_at timestamptz,
 purchase_change_minor text,balance_minor text,ledger_change_minor text,active boolean)
language sql stable set search_path = '' as $$
 select a.id,a.name,a.kind,b.amount_minor::text,b.effective_at,
  calculated.purchase_change::text,calculated.balance::text,calculated.ledger_change::text,a.active
 from public.financial_accounts a
 left join public.account_opening_balances b on b.user_id=a.user_id and b.account_id=a.id
 left join lateral public.calculate_account_balance(a.id,statement_timestamp()) calculated on true
 where a.user_id=(select auth.uid()) and a.kind in ('asset','liability') and a.currency='KRW'
  and (a.active or b.account_id is not null)
 order by a.kind,a.name,a.id;
$$;

create function public.record_account_balance_check(
 p_account_id uuid,p_actual_minor text,p_observed_at timestamptz,p_request_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
 uid uuid := auth.uid();
 check_row public.account_balance_checks%rowtype;
 actual bigint;
 calculated numeric;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_account_id is null or p_actual_minor is null or p_actual_minor !~ '^(0|-?[1-9][0-9]{0,18})$'
  or p_observed_at is null or not isfinite(p_observed_at) or p_observed_at>statement_timestamp()
  or p_request_id is null then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 actual := p_actual_minor::bigint;
 perform pg_advisory_xact_lock(hashtextextended('balance_check:' || uid::text || ':' || p_request_id::text,0));
 select * into check_row from public.account_balance_checks where user_id=uid and request_id=p_request_id;
 if found then
  if check_row.account_id<>p_account_id or check_row.actual_minor<>actual or check_row.observed_at<>p_observed_at then
   raise exception 'BALANCE_CHECK_REQUEST_CONFLICT' using errcode='23505';
  end if;
 else
  if not exists (select 1 from public.financial_accounts where user_id=uid and id=p_account_id) then
   raise exception 'ACCOUNT_NOT_FOUND' using errcode='P0002';
  end if;
  select balance into calculated from public.calculate_account_balance(p_account_id,p_observed_at);
  if calculated is null then raise exception 'OPENING_BALANCE_REQUIRED' using errcode='22023'; end if;
  insert into public.account_balance_checks(user_id,account_id,request_id,observed_at,actual_minor,ledger_minor)
  values(uid,p_account_id,p_request_id,p_observed_at,actual,calculated) returning * into check_row;
 end if;
 return jsonb_build_object('id',check_row.id,'ledger_minor',check_row.ledger_minor::text,
  'actual_minor',check_row.actual_minor::text,'difference_minor',(check_row.actual_minor-check_row.ledger_minor)::text);
end;
$$;

create function public.list_account_balance_checks(p_limit integer default 30) returns table (
 id uuid,account_name text,observed_at timestamptz,actual_minor text,ledger_minor text,difference_minor text
)
language sql stable set search_path = '' as $$
 select b.id,a.name,b.observed_at,b.actual_minor::text,b.ledger_minor::text,(b.actual_minor-b.ledger_minor)::text
 from public.account_balance_checks b join public.financial_accounts a on a.user_id=b.user_id and a.id=b.account_id
 where b.user_id=(select auth.uid()) order by b.observed_at desc,b.id desc limit greatest(0,least(coalesce(p_limit,30),100))
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
  select t.id,t.kind,t.amount_minor from public.transactions t where t.user_id=uid and t.currency='KRW'
   and t.kind<>'opening_balance' and t.occurred_at>=period_start and t.occurred_at<period_end
 ), spending as (
  select a.id as purchase_id,null::bigint as refund_minor from activity a
   where a.kind in ('purchase_credit','purchase_debit','purchase_cash')
  union all
  select m.original_purchase_id,a.amount_minor from activity a
  join public.account_movements m on m.user_id=uid and m.transaction_id=a.id
  where a.kind='purchase_refund'
 ), categories as (
  select c.id,c.name,sum(case when p.refund_minor is null then s.amount_minor else -p.refund_minor end)::text as amount_minor
  from spending p join public.transaction_splits s on s.user_id=uid and s.transaction_id=p.purchase_id
  join public.categories c on c.user_id=uid and c.id=s.category_id
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
   coalesce(sum(a.amount_minor) filter(where a.kind='purchase_refund'),0) as refunds
  from activity a
 )
 select jsonb_build_object('month',to_char(p_month,'YYYY-MM'),'currency','KRW',
  'purchase_count',t.purchase_count,'spending_minor',(t.gross-t.refunds)::text,
  'gross_spending_minor',t.gross::text,'refund_minor',t.refunds::text,
  'categories',coalesce((select jsonb_agg(to_jsonb(c) order by c.name,c.id) from categories c),'[]'::jsonb),
  'accounts',coalesce((select jsonb_agg(to_jsonb(a) order by a.kind,a.name,a.id) from accounts a),'[]'::jsonb))
 into summary from totals t;
 return summary;
end;
$$;

revoke all on function public.post_account_movement(text,text,timestamptz,uuid,uuid,uuid,uuid) from public,anon;
revoke all on function public.calculate_account_balance(uuid,timestamptz) from public,anon;
revoke all on function public.list_account_balances() from public,anon;
revoke all on function public.record_account_balance_check(uuid,text,timestamptz,uuid) from public,anon;
revoke all on function public.list_account_balance_checks(integer) from public,anon;
grant execute on function public.post_account_movement(text,text,timestamptz,uuid,uuid,uuid,uuid) to authenticated;
grant execute on function public.calculate_account_balance(uuid,timestamptz) to authenticated;
grant execute on function public.list_account_balances() to authenticated;
grant execute on function public.record_account_balance_check(uuid,text,timestamptz,uuid) to authenticated;
grant execute on function public.list_account_balance_checks(integer) to authenticated;
