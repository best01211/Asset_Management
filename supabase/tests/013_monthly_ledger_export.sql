begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','13131313-1313-4131-8131-111111111111',true);
do $$
declare
 uid uuid := auth.uid();
 asset uuid;
 expense uuid;
 category uuid;
 draft uuid;
 txid uuid;
 transactions jsonb;
 postings jsonb;
begin
 insert into public.financial_accounts(user_id,name,kind) values(uid,'Export asset','asset') returning id into asset;
 insert into public.financial_accounts(user_id,name,kind) values(uid,'Export expense','expense') returning id into expense;
 insert into public.categories(user_id,name,expense_account_id) values(uid,'Export category',expense) returning id into category;
 draft := public.create_pending_expense('Before month',1,'2024-01-31T14:59:59.999999Z','cash',asset,category);
 perform public.approve_pending_expense(draft,1,gen_random_uuid());
 draft := public.create_pending_expense('=quoted "merchant", test',9007199254740993,'2024-01-31T15:00:00.123456Z','cash',asset,category);
 txid := (public.approve_pending_expense(draft,1,gen_random_uuid())->>'transaction_id')::uuid;
 perform public.create_pending_expense('Pending private notice',1,'2024-02-02T00:00:00Z','cash',asset,category);
 transactions := public.get_monthly_ledger_export('2024-02-01','transactions');
 postings := public.get_monthly_ledger_export('2024-02-01','entries');
 if jsonb_array_length(transactions)<>1 or transactions->0->>0 is distinct from txid::text
  or transactions->0->>3 is distinct from '9007199254740993'
  or transactions->0->>5 is distinct from '2024-01-31T15:00:00.123456Z'
  or jsonb_array_length(postings)<>2 or postings->0->>1 is distinct from txid::text
  or postings->1->>6 is distinct from '9007199254740993'
 then raise exception 'EXPORT_BOUNDARY_OR_PRECISION_FAILED'; end if;
 perform set_config('request.jwt.claim.sub','13131313-1313-4131-8131-222222222222',true);
 if public.get_monthly_ledger_export('2024-02-01','transactions') is distinct from '[]'::jsonb
  or public.get_monthly_ledger_export('2024-02-01','entries') is distinct from '[]'::jsonb
 then raise exception 'EXPORT_CROSS_USER_DATA_VISIBLE'; end if;
end
$$;
set constraints all immediate;
rollback;
