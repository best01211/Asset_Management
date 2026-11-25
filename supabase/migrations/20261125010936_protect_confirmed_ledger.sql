-- Keep an account's accounting identity stable and constrain category links.
alter table public.financial_accounts
 add constraint financial_accounts_owner_id_kind_key unique (user_id,id,kind);

alter table public.categories
 add column expense_account_kind text generated always as ('expense'::text) stored;

alter table public.categories
 add constraint category_expense_account_kind_fk
 foreign key (user_id,expense_account_id,expense_account_kind)
 references public.financial_accounts(user_id,id,kind) on delete restrict,
 drop constraint categories_user_id_expense_account_id_fkey;

create function public.reject_ledger_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
 raise exception 'CONFIRMED_LEDGER_IMMUTABLE' using errcode='55000';
end;
$$;

create trigger account_identity_immutable before update on public.financial_accounts
 for each row when (old.id is distinct from new.id or old.user_id is distinct from new.user_id
  or old.kind is distinct from new.kind or old.currency is distinct from new.currency)
 execute function public.reject_ledger_mutation();

create trigger confirmed_purchase_immutable before update or delete on public.transactions
 for each row execute function public.reject_ledger_mutation();
create trigger confirmed_ledger_entry_immutable before update or delete on public.ledger_entries
 for each row execute function public.reject_ledger_mutation();
create trigger confirmed_split_immutable before update or delete on public.transaction_splits
 for each row execute function public.reject_ledger_mutation();
create trigger confirmed_draft_immutable before update or delete on public.pending_transactions
 for each row when (old.status='confirmed') execute function public.reject_ledger_mutation();

create trigger confirmed_purchase_no_truncate before truncate on public.transactions
 for each statement execute function public.reject_ledger_mutation();
create trigger confirmed_ledger_no_truncate before truncate on public.ledger_entries
 for each statement execute function public.reject_ledger_mutation();
create trigger confirmed_split_no_truncate before truncate on public.transaction_splits
 for each statement execute function public.reject_ledger_mutation();

-- The approval RPC locks the draft, posts its detail rows, then confirms the draft.
-- Take a compatible lock during posting so late inserts see a completed approval.
create function public.require_open_ledger_posting() returns trigger
language plpgsql set search_path = '' as $$
declare draft_status text;
begin
 select p.status into draft_status
 from public.transactions t join public.pending_transactions p
  on p.user_id=t.user_id and p.id=t.source_pending_id
 where t.user_id=new.user_id and t.id=new.transaction_id
 for share of p;
 if draft_status is distinct from 'pending_review' then
  raise exception 'CONFIRMED_LEDGER_IMMUTABLE' using errcode='55000';
 end if;
 return new;
end;
$$;

create trigger ledger_entry_requires_open_posting before insert on public.ledger_entries
 for each row execute function public.require_open_ledger_posting();
create trigger split_requires_open_posting before insert on public.transaction_splits
 for each row execute function public.require_open_ledger_posting();

-- Validate both new transactions and postings. Checking the transaction itself
-- also catches a transaction with no matching ledger entries.
create or replace function public.assert_balanced_ledger() returns trigger
language plpgsql security definer set search_path = '' as $$
declare txid uuid; tx record; deb numeric; cred numeric; valid_currency boolean;
begin
 if tg_table_name='transactions' then
  txid := new.id;
 else
  txid := new.transaction_id;
 end if;

 select t.currency,t.amount_minor,p.status,p.confirmed_transaction_id into tx
 from public.transactions t join public.pending_transactions p
  on p.user_id=t.user_id and p.id=t.source_pending_id
 where t.user_id=new.user_id and t.id=txid;

 select sum(e.amount_minor) filter(where e.side='debit'),
        sum(e.amount_minor) filter(where e.side='credit'),
        bool_and(e.currency=tx.currency and a.currency=tx.currency)
 into deb,cred,valid_currency
 from public.ledger_entries e join public.financial_accounts a
  on a.user_id=e.user_id and a.id=e.account_id
 where e.user_id=new.user_id and e.transaction_id=txid;

 if tx.status is distinct from 'confirmed' or tx.confirmed_transaction_id is distinct from txid
  or deb is distinct from tx.amount_minor or cred is distinct from tx.amount_minor
  or valid_currency is not true then
  raise exception 'LEDGER_UNBALANCED' using errcode='23514';
 end if;
 return null;
end;
$$;

create constraint trigger purchase_requires_balanced_ledger
 after insert on public.transactions deferrable initially deferred
 for each row execute function public.assert_balanced_ledger();

revoke all on function public.reject_ledger_mutation() from public,anon,authenticated;
revoke all on function public.require_open_ledger_posting() from public,anon,authenticated;
