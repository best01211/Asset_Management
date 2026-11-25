alter table public.transactions
 alter column source_pending_id drop not null,
 drop constraint transactions_kind_check,
 add constraint transactions_source_matches_kind check (
  (kind='opening_balance' and source_pending_id is null)
  or (kind in ('purchase_credit','purchase_debit','purchase_cash') and source_pending_id is not null));

create table public.account_opening_balances (
 user_id uuid not null,
 account_id uuid not null,
 amount_minor bigint not null check (amount_minor>=0),
 effective_at timestamptz not null check (isfinite(effective_at)),
 transaction_id uuid,
 equity_account_id uuid,
 created_at timestamptz not null default now(),
 primary key(user_id,account_id),
 unique(user_id,transaction_id),
 foreign key(user_id,account_id) references public.financial_accounts(user_id,id),
 foreign key(user_id,transaction_id) references public.transactions(user_id,id),
 foreign key(user_id,equity_account_id) references public.financial_accounts(user_id,id),
 check (
  (amount_minor=0 and transaction_id is null and equity_account_id is null)
  or (amount_minor>0 and transaction_id is not null and equity_account_id is not null and equity_account_id<>account_id))
);

alter table public.account_opening_balances enable row level security;
revoke all on public.account_opening_balances from public,anon,authenticated;
grant select on public.account_opening_balances to authenticated;
create policy opening_balance_owner_read on public.account_opening_balances for select to authenticated
 using ((select auth.uid())=user_id);
create trigger opening_balance_immutable before update or delete on public.account_opening_balances
 for each row execute function public.reject_ledger_mutation();
create trigger opening_balance_no_truncate before truncate on public.account_opening_balances
 for each statement execute function public.reject_ledger_mutation();

create or replace function public.require_open_ledger_posting() returns trigger
language plpgsql set search_path = '' as $$
declare posting_kind text; draft_status text;
begin
 select kind into posting_kind from public.transactions
 where user_id=new.user_id and id=new.transaction_id;

 if posting_kind='opening_balance' then
  if tg_table_name='ledger_entries' then
   perform 1 from public.transactions where user_id=new.user_id and id=new.transaction_id for no key update;
   if not exists (select 1 from public.account_opening_balances
    where user_id=new.user_id and transaction_id=new.transaction_id) then
    return new;
   end if;
  end if;
  raise exception 'CONFIRMED_LEDGER_IMMUTABLE' using errcode='55000';
 end if;

 select p.status into draft_status
 from public.transactions t join public.pending_transactions p
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
 deb numeric;
 cred numeric;
 valid_currency boolean;
 line_count integer;
begin
 if tg_table_name='transactions' then txid := new.id; else txid := new.transaction_id; end if;

 select t.kind,t.currency,t.amount_minor,t.occurred_at,p.status,p.confirmed_transaction_id into tx
 from public.transactions t left join public.pending_transactions p
  on p.user_id=t.user_id and p.id=t.source_pending_id
 where t.user_id=new.user_id and t.id=txid;

 select sum(e.amount_minor) filter(where e.side='debit'),
        sum(e.amount_minor) filter(where e.side='credit'),
        bool_and(e.currency=tx.currency and a.currency=tx.currency),count(*)
 into deb,cred,valid_currency,line_count
 from public.ledger_entries e join public.financial_accounts a on a.user_id=e.user_id and a.id=e.account_id
 where e.user_id=new.user_id and e.transaction_id=txid;

 if deb is distinct from tx.amount_minor or cred is distinct from tx.amount_minor or valid_currency is not true then
  raise exception 'LEDGER_UNBALANCED' using errcode='23514';
 end if;

 if tx.kind='opening_balance' then
  select b.account_id,b.equity_account_id,b.amount_minor,b.effective_at,a.kind
  into opening
  from public.account_opening_balances b
  join public.financial_accounts a on a.user_id=b.user_id and a.id=b.account_id
  join public.financial_accounts eq on eq.user_id=b.user_id and eq.id=b.equity_account_id and eq.kind='equity'
  where b.user_id=new.user_id and b.transaction_id=txid;
  if not found or tx.currency<>'KRW' or opening.kind not in ('asset','liability')
   or opening.amount_minor<>tx.amount_minor or opening.effective_at<>tx.occurred_at or line_count<>2
   or not exists (
    select 1 from public.ledger_entries where user_id=new.user_id and transaction_id=txid
     and account_id=opening.account_id and side=case opening.kind when 'asset' then 'debit' else 'credit' end
   ) or not exists (
    select 1 from public.ledger_entries where user_id=new.user_id and transaction_id=txid
     and account_id=opening.equity_account_id and side=case opening.kind when 'asset' then 'credit' else 'debit' end
   ) then raise exception 'LEDGER_UNBALANCED' using errcode='23514'; end if;
 elsif tx.status is distinct from 'confirmed' or tx.confirmed_transaction_id is distinct from txid then
  raise exception 'LEDGER_UNBALANCED' using errcode='23514';
 end if;
 return null;
end;
$$;

create function public.record_account_opening_balance(
 p_account_id uuid,p_amount_minor text,p_effective_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
 uid uuid := auth.uid();
 account_row public.financial_accounts%rowtype;
 previous public.account_opening_balances%rowtype;
 balance_minor bigint;
 txid uuid;
 equity_id uuid;
 account_side text;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_account_id is null or p_amount_minor is null or p_amount_minor !~ '^(0|[1-9][0-9]{0,18})$'
  or p_effective_at is null or not isfinite(p_effective_at) or p_effective_at>statement_timestamp() then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;
 balance_minor := p_amount_minor::bigint;

 select * into account_row from public.financial_accounts
 where user_id=uid and id=p_account_id for update;
 if not found then raise exception 'ACCOUNT_NOT_FOUND' using errcode='P0002'; end if;

 select * into previous from public.account_opening_balances where user_id=uid and account_id=p_account_id;
 if found then
  if previous.amount_minor<>balance_minor or previous.effective_at<>p_effective_at then
   raise exception 'OPENING_BALANCE_ALREADY_RECORDED' using errcode='23505';
  end if;
  return jsonb_build_object('account_id',p_account_id,'transaction_id',previous.transaction_id,'replayed',true);
 end if;
 if account_row.kind not in ('asset','liability') or account_row.currency<>'KRW' or not account_row.active then
  raise exception 'ACCOUNT_NOT_ELIGIBLE' using errcode='22023';
 end if;

 if balance_minor>0 then
  account_side := case when account_row.kind='asset' then 'debit' else 'credit' end;
  insert into public.financial_accounts(user_id,name,kind,currency)
   values(uid,'초기 잔액 상계','equity','KRW') returning id into equity_id;
  insert into public.transactions(user_id,kind,amount_minor,currency,merchant,occurred_at)
   values(uid,'opening_balance',balance_minor,'KRW','초기 잔액',p_effective_at) returning id into txid;
  insert into public.ledger_entries(user_id,transaction_id,account_id,side,amount_minor,currency)
   values(uid,txid,p_account_id,account_side,balance_minor,'KRW'),
    (uid,txid,equity_id,case when account_side='debit' then 'credit' else 'debit' end,balance_minor,'KRW');
 end if;

 insert into public.account_opening_balances(user_id,account_id,amount_minor,effective_at,transaction_id,equity_account_id)
 values(uid,p_account_id,balance_minor,p_effective_at,txid,equity_id);
 insert into public.audit_logs(user_id,entity_type,entity_id,action,details)
 values(uid,'financial_account',p_account_id,'opening_balance',jsonb_build_object(
  'amount_minor',balance_minor::text,'effective_at',p_effective_at,'transaction_id',txid));
 return jsonb_build_object('account_id',p_account_id,'transaction_id',txid,'replayed',false);
end;
$$;

create function public.list_account_balances()
returns table (id uuid,name text,kind text,opening_amount_minor text,opening_effective_at timestamptz,
 purchase_change_minor text,balance_minor text)
language sql stable set search_path = '' as $$
 select a.id,a.name,a.kind,b.amount_minor::text,b.effective_at,
  case when b.account_id is not null then changes.amount::text end,
  (b.amount_minor + changes.amount)::text
 from public.financial_accounts a
 left join public.account_opening_balances b on b.user_id=a.user_id and b.account_id=a.id
 left join lateral (
  select coalesce(sum(case when (a.kind='asset' and e.side='debit') or (a.kind='liability' and e.side='credit')
   then e.amount_minor else -e.amount_minor end),0) as amount
  from public.ledger_entries e join public.transactions t on t.user_id=e.user_id and t.id=e.transaction_id
  where b.account_id is not null and e.user_id=a.user_id and e.account_id=a.id
   and t.kind in ('purchase_credit','purchase_debit','purchase_cash')
   and t.currency='KRW' and t.occurred_at>=b.effective_at and t.occurred_at<=statement_timestamp()
 ) changes on true
 where a.user_id=(select auth.uid()) and a.kind in ('asset','liability') and a.currency='KRW'
  and (a.active or b.account_id is not null)
 order by a.kind,a.name,a.id;
$$;

revoke all on function public.record_account_opening_balance(uuid,text,timestamptz) from public,anon;
revoke all on function public.list_account_balances() from public,anon;
grant execute on function public.record_account_opening_balance(uuid,text,timestamptz) to authenticated;
grant execute on function public.list_account_balances() to authenticated;
