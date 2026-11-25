-- Q79 MVP: KRW expense approval with balanced immutable ledger.
-- Apply through Supabase migration as an admin/postgres role, NOT from a client.
-- gen_random_uuid() is built into supported PostgreSQL versions.

create table public.financial_accounts (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null,
 name text not null check (length(trim(name)) between 1 and 100),
 kind text not null check (kind in ('asset','liability','expense','income','equity')),
 currency text not null default 'KRW' check (currency ~ '^[A-Z]{3}$'),
 active boolean not null default true,
 created_at timestamptz not null default now(),
 unique (user_id,id)
);
create index financial_accounts_owner_idx on public.financial_accounts(user_id,kind);

create table public.categories (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null,
 name text not null check (length(trim(name)) between 1 and 80),
 expense_account_id uuid not null,
 created_at timestamptz not null default now(),
 unique (user_id,id),
 foreign key (user_id, expense_account_id) references public.financial_accounts(user_id,id) on delete restrict
);
create index categories_owner_idx on public.categories(user_id);

create table public.notification_events (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null,
 device_event_id text not null check(length(device_event_id) between 1 and 200),
 source_package text not null,
 -- Persist only required/minimized original data. Full notification text may be sensitive.
 payload jsonb not null default '{}'::jsonb,
 received_at timestamptz not null,
 created_at timestamptz not null default now(),
 unique(user_id,id),
 unique(user_id,device_event_id)
);

create table public.pending_transactions (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null,
 notification_event_id uuid,
 merchant text not null check (length(trim(merchant)) between 1 and 200),
 amount_minor bigint not null check (amount_minor > 0),
 currency text not null default 'KRW' check(currency ~ '^[A-Z]{3}$'),
 occurred_at timestamptz not null,
 payment_method text not null check (payment_method in ('credit_card','debit_card','cash')),
 payment_account_id uuid not null,
 category_id uuid not null,
 status text not null default 'pending_review' check(status in ('pending_review','duplicate_suspected','confirmed','dismissed')),
 version integer not null default 1 check(version > 0),
 confirmed_transaction_id uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(user_id,id),
 unique(user_id,notification_event_id),
 foreign key(user_id,notification_event_id) references public.notification_events(user_id,id),
 foreign key(user_id,payment_account_id) references public.financial_accounts(user_id,id),
 foreign key(user_id,category_id) references public.categories(user_id,id)
);
create index pending_owner_status_idx on public.pending_transactions(user_id,status,occurred_at desc);

create table public.transactions (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null,
 source_pending_id uuid not null,
 kind text not null check(kind in ('purchase_credit','purchase_debit','purchase_cash')),
 amount_minor bigint not null check(amount_minor > 0),
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 merchant text not null,
 occurred_at timestamptz not null,
 created_at timestamptz not null default now(),
 unique(user_id,id),
 unique(user_id,source_pending_id),
 foreign key(user_id,source_pending_id) references public.pending_transactions(user_id,id)
);

alter table public.pending_transactions
 add constraint pending_confirmed_transaction_fk
 foreign key (user_id, confirmed_transaction_id) references public.transactions(user_id,id);

create table public.ledger_entries (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null,
 transaction_id uuid not null,
 account_id uuid not null,
 side text not null check(side in ('debit','credit')),
 amount_minor bigint not null check(amount_minor > 0),
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 created_at timestamptz not null default now(),
 foreign key(user_id,transaction_id) references public.transactions(user_id,id),
 foreign key(user_id,account_id) references public.financial_accounts(user_id,id)
);
create index ledger_owner_transaction_idx on public.ledger_entries(user_id,transaction_id);
create index ledger_owner_account_idx on public.ledger_entries(user_id,account_id);

create table public.transaction_splits (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null,
 transaction_id uuid not null,
 category_id uuid not null,
 amount_minor bigint not null check(amount_minor>0),
 foreign key(user_id,transaction_id) references public.transactions(user_id,id),
 foreign key(user_id,category_id) references public.categories(user_id,id)
);
create index splits_owner_transaction_idx on public.transaction_splits(user_id,transaction_id);

create table public.approval_requests (
 user_id uuid not null,
 idempotency_key uuid not null,
 pending_id uuid not null,
 transaction_id uuid not null,
 created_at timestamptz not null default now(),
 primary key(user_id,idempotency_key),
 foreign key(user_id,pending_id) references public.pending_transactions(user_id,id),
 foreign key(user_id,transaction_id) references public.transactions(user_id,id)
);

create table public.audit_logs (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null,
 entity_type text not null,
 entity_id uuid not null,
 action text not null,
 details jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);
create index audit_owner_time_idx on public.audit_logs(user_id,created_at desc);

-- Deferrable cross-row balance assertion, executed at transaction commit.
create function public.assert_balanced_ledger() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n integer; deb numeric; cred numeric; tx_currency text;
begin
 select t.currency into tx_currency from public.transactions t
  where t.id = new.transaction_id and t.user_id = new.user_id;
 select count(*), coalesce(sum(e.amount_minor) filter(where e.side='debit'),0),
     coalesce(sum(e.amount_minor) filter(where e.side='credit'),0)
 into n,deb,cred from public.ledger_entries e
 where e.transaction_id = new.transaction_id and e.user_id = new.user_id;
 if n < 2 or deb <> cred or exists(
   select 1 from public.ledger_entries e
   where e.transaction_id = new.transaction_id and e.user_id=new.user_id
     and e.currency <> tx_currency
 ) then
   raise exception 'LEDGER_UNBALANCED' using errcode='23514';
 end if;
 return null;
end;
$$;
create constraint trigger ledger_balanced_after_insert
 after insert on public.ledger_entries deferrable initially deferred
 for each row execute function public.assert_balanced_ledger();

-- Restricted client rights. Confirmed records are exclusively written by the RPC.
revoke all on public.financial_accounts,public.categories,public.notification_events,
 public.pending_transactions,public.transactions,public.ledger_entries,
 public.transaction_splits,public.approval_requests,public.audit_logs from anon,authenticated;
grant select on public.financial_accounts,public.categories,public.notification_events,
 public.pending_transactions,public.transactions,public.ledger_entries,
 public.transaction_splits,public.audit_logs to authenticated;
grant insert on public.financial_accounts,public.categories to authenticated;
grant update(name,active) on public.financial_accounts to authenticated;
grant update(name) on public.categories to authenticated;

-- RLS on all user-owned tables. Writes to financial history have NO direct policy.
do $$ declare t text; begin
 foreach t in array array[
 'financial_accounts','categories','notification_events','pending_transactions',
 'transactions','ledger_entries','transaction_splits','approval_requests','audit_logs'
 ] loop
  execute format('alter table public.%I enable row level security', t);
  execute format('create policy owner_read on public.%I for select to authenticated using ((select auth.uid()) = user_id)',t);
 end loop;
end $$;
create policy account_owner_insert on public.financial_accounts for insert to authenticated
 with check ((select auth.uid()) = user_id);
create policy account_owner_update on public.financial_accounts for update to authenticated
 using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy category_owner_insert on public.categories for insert to authenticated
 with check ((select auth.uid()) = user_id);
create policy category_owner_update on public.categories for update to authenticated
 using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Authenticated ingestion API: a client may create a draft, never post its ledger.
create function public.create_pending_expense(
 p_merchant text,p_amount_minor bigint,p_occurred_at timestamptz,
 p_payment_method text,p_payment_account_id uuid,p_category_id uuid,
 p_notification_event_id uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); pid uuid; ac record; cat record;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_amount_minor is null or p_amount_minor <= 0 or p_merchant is null or trim(p_merchant) = ''
  or p_occurred_at is null or p_payment_method not in ('credit_card','debit_card','cash')
 then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 select kind,currency,active into ac from public.financial_accounts
  where user_id=uid and id=p_payment_account_id;
 select a.kind as expense_kind,a.currency as expense_currency
  into cat from public.categories c join public.financial_accounts a
  on a.user_id=c.user_id and a.id=c.expense_account_id
  where c.user_id=uid and c.id=p_category_id;
 if not found or cat.expense_kind <> 'expense' or cat.expense_currency <> 'KRW'
  or ac.currency <> 'KRW' or not coalesce(ac.active,false) or
  (p_payment_method='credit_card' and ac.kind <> 'liability') or
  (p_payment_method in ('debit_card','cash') and ac.kind <> 'asset')
 then raise exception 'ACCOUNT_CATEGORY_MISMATCH' using errcode='22023'; end if;
 if p_notification_event_id is not null and not exists (
  select 1 from public.notification_events where user_id=uid and id=p_notification_event_id
 ) then raise exception 'EVENT_NOT_FOUND' using errcode='22023'; end if;
 insert into public.pending_transactions(user_id,notification_event_id,merchant,amount_minor,
  currency,occurred_at,payment_method,payment_account_id,category_id)
 values(uid,p_notification_event_id,trim(p_merchant),p_amount_minor,'KRW',p_occurred_at,
  p_payment_method,p_payment_account_id,p_category_id) returning id into pid;
 return pid;
end;
$$;

-- Single authoritative transaction approval. Serializable behavior per pending row.
create function public.approve_pending_expense(
 p_pending_id uuid,p_expected_version integer,p_idempotency_key uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); p record; acc record; expense_id uuid;
 txid uuid; previous record; txkind text;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_pending_id is null or p_expected_version is null or p_idempotency_key is null
 then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 -- Serialize concurrent approvals of this same draft, including different request keys.
 select * into p from public.pending_transactions
 where id=p_pending_id and user_id=uid for update;
 if not found then raise exception 'PENDING_NOT_FOUND' using errcode='P0002'; end if;
 select * into previous from public.approval_requests
 where user_id=uid and idempotency_key=p_idempotency_key;
 if found then
  if previous.pending_id <> p_pending_id then
   raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode='23505';
  end if;
  return jsonb_build_object('status','confirmed','transaction_id',previous.transaction_id,
   'ledger_posted',true,'replayed',true);
 end if;
 if p.status <> 'pending_review' or p.version <> p_expected_version then
   raise exception 'STALE_OR_NOT_REVIEWABLE' using errcode='P0001';
 end if;
 select * into acc from public.financial_accounts
 where id=p.payment_account_id and user_id=uid;
 select a.id into expense_id from public.categories c
 join public.financial_accounts a on a.id=c.expense_account_id and a.user_id=c.user_id
 where c.id=p.category_id and c.user_id=uid
   and a.kind='expense' and a.currency=p.currency;
 if expense_id is null or acc.id is null or acc.currency <> p.currency
   or p.currency <> 'KRW' or not acc.active or
   (p.payment_method='credit_card' and acc.kind <> 'liability') or
   (p.payment_method in ('debit_card','cash') and acc.kind <> 'asset') then
  raise exception 'ACCOUNT_CATEGORY_MISMATCH' using errcode='22023';
 end if;
 txkind := case p.payment_method when 'credit_card' then 'purchase_credit'
       when 'debit_card' then 'purchase_debit' else 'purchase_cash' end;
 insert into public.transactions(user_id,source_pending_id,kind,amount_minor,currency,merchant,occurred_at)
 values(uid,p.id,txkind,p.amount_minor,p.currency,p.merchant,p.occurred_at)
 returning id into txid;
 insert into public.ledger_entries(user_id,transaction_id,account_id,side,amount_minor,currency)
 values (uid,txid,expense_id,'debit',p.amount_minor,p.currency),
        (uid,txid,p.payment_account_id,'credit',p.amount_minor,p.currency);
 insert into public.transaction_splits(user_id,transaction_id,category_id,amount_minor)
 values(uid,txid,p.category_id,p.amount_minor);
 update public.pending_transactions set status='confirmed',confirmed_transaction_id=txid,
  version=version+1,updated_at=now() where id=p.id and user_id=uid;
 insert into public.approval_requests(user_id,idempotency_key,pending_id,transaction_id)
 values(uid,p_idempotency_key,p.id,txid);
 insert into public.audit_logs(user_id,entity_type,entity_id,action,details)
 values(uid,'pending_transaction',p.id,'confirm',jsonb_build_object('transaction_id',txid,
  'amount_minor',p.amount_minor,'payment_method',p.payment_method));
 return jsonb_build_object('status','confirmed','transaction_id',txid,
  'ledger_posted',true,'replayed',false);
end;
$$;

-- Minimal authenticated event ingestion; event IDs must be stable across retries.
create function public.record_notification_event(
 p_device_event_id text,p_source_package text,p_received_at timestamptz,p_payload jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); eid uuid;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_device_event_id is null or length(p_device_event_id) not between 1 and 200
   or p_source_package is null or length(p_source_package) not between 1 and 200
   or p_received_at is null or jsonb_typeof(coalesce(p_payload,'{}'::jsonb)) <> 'object'
 then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 insert into public.notification_events(user_id,device_event_id,source_package,received_at,payload)
 values(uid,p_device_event_id,p_source_package,p_received_at,coalesce(p_payload,'{}'::jsonb))
 on conflict (user_id,device_event_id) do nothing returning id into eid;
 if eid is null then select id into eid from public.notification_events
  where user_id=uid and device_event_id=p_device_event_id; end if;
 return eid;
end;
$$;

revoke all on function public.assert_balanced_ledger() from public,anon,authenticated;
revoke all on function public.create_pending_expense(text,bigint,timestamptz,text,uuid,uuid,uuid) from public,anon;
revoke all on function public.approve_pending_expense(uuid,integer,uuid) from public,anon;
revoke all on function public.record_notification_event(text,text,timestamptz,jsonb) from public,anon;
grant execute on function public.create_pending_expense(text,bigint,timestamptz,text,uuid,uuid,uuid) to authenticated;
grant execute on function public.approve_pending_expense(uuid,integer,uuid) to authenticated;
grant execute on function public.record_notification_event(text,text,timestamptz,jsonb) to authenticated;
