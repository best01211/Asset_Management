create table public.monthly_budgets (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null,
 budget_month date not null check (
  budget_month between date '1900-01-01' and date '9998-12-01' and extract(day from budget_month)=1),
 category_id uuid,
 amount_minor bigint check (amount_minor>=0),
 version integer not null default 1 check(version>0),
 updated_at timestamptz not null default now(),
 unique nulls not distinct (user_id,budget_month,category_id),
 foreign key(user_id,category_id) references public.categories(user_id,id)
);
alter table public.monthly_budgets enable row level security;
revoke all on public.monthly_budgets from public,anon,authenticated;
grant select on public.monthly_budgets to authenticated;
create policy monthly_budget_owner_read on public.monthly_budgets for select to authenticated
 using ((select auth.uid())=user_id);

create function public.get_monthly_budget(p_month date) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
 uid uuid := auth.uid();
 summary jsonb;
 total jsonb;
 breakdown jsonb;
begin
 summary := public.summarize_confirmed_purchases(p_month);
 select jsonb_build_object('amount_minor',amount_minor::text,'version',version) into total
 from public.monthly_budgets where user_id=uid and budget_month=p_month and category_id is null;
 select coalesce(jsonb_agg(jsonb_build_object(
  'category_id',c.id,'name',c.name,'spent_minor',coalesce(expenditure.item->>'amount_minor','0'),
  'amount_minor',b.amount_minor::text,'version',b.version
 ) order by c.name,c.id),'[]'::jsonb) into breakdown
 from public.categories c
 join public.financial_accounts a on a.user_id=c.user_id and a.id=c.expense_account_id and a.currency='KRW' and a.kind='expense'
 left join public.monthly_budgets b on b.user_id=uid and b.budget_month=p_month and b.category_id=c.id
 left join lateral (
  select item from jsonb_array_elements(summary->'categories') item where item->>'id'=c.id::text
 ) expenditure on true
 where c.user_id=uid;
 return jsonb_build_object('month',summary->>'month','spent_minor',summary->>'spending_minor',
  'total',total,'categories',breakdown);
end;
$$;

-- Expected version 0 creates a missing budget. A null amount removes a versioned budget.
create function public.save_monthly_budget(
 p_month date,p_category_id uuid,p_amount_minor text,p_expected_version integer
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
 uid uuid := auth.uid();
 row_before public.monthly_budgets%rowtype;
 row_after public.monthly_budgets%rowtype;
 amount bigint;
 action text := 'save';
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_month is null or p_month not between date '1900-01-01' and date '9998-12-01' or extract(day from p_month)<>1
  or p_expected_version is null or p_expected_version<0
  or (p_amount_minor is null and p_expected_version=0)
  or (p_amount_minor is not null and p_amount_minor !~ '^(0|[1-9][0-9]{0,18})$')
  then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 amount := p_amount_minor::bigint;
 if p_category_id is not null and not exists (
  select 1 from public.categories c join public.financial_accounts a
   on a.user_id=c.user_id and a.id=c.expense_account_id
  where c.user_id=uid and c.id=p_category_id and a.kind='expense' and a.currency='KRW'
 ) then raise exception 'BUDGET_CATEGORY_NOT_FOUND' using errcode='P0002'; end if;

 if p_expected_version=0 then
  insert into public.monthly_budgets(user_id,budget_month,category_id,amount_minor)
  values(uid,p_month,p_category_id,amount)
  on conflict (user_id,budget_month,category_id) do nothing returning * into row_after;
  if not found then raise exception 'BUDGET_VERSION_CHANGED' using errcode='P0001'; end if;
 else
  select * into row_before from public.monthly_budgets
  where user_id=uid and budget_month=p_month and category_id is not distinct from p_category_id for update;
  if not found or row_before.version<>p_expected_version then
   raise exception 'BUDGET_VERSION_CHANGED' using errcode='P0001';
  end if;
  if row_before.amount_minor is not distinct from amount then
   return jsonb_build_object('version',row_before.version,'amount_minor',p_amount_minor);
  end if;
  if amount is null then action := 'remove'; end if;
  -- Retain the version after removal so an older edit cannot overwrite a new budget.
  update public.monthly_budgets set amount_minor=amount,version=version+1,updated_at=now()
  where user_id=uid and id=row_before.id returning * into row_after;
 end if;
 insert into public.audit_logs(user_id,entity_type,entity_id,action,details)
 values(uid,'monthly_budget',coalesce(row_after.id,row_before.id),action,jsonb_build_object(
  'month',p_month,'category_id',p_category_id,'before_minor',row_before.amount_minor::text,'after_minor',p_amount_minor));
 return jsonb_build_object('version',row_after.version,'amount_minor',p_amount_minor);
end;
$$;

revoke all on function public.get_monthly_budget(date) from public,anon;
revoke all on function public.save_monthly_budget(date,uuid,text,integer) from public,anon;
grant execute on function public.get_monthly_budget(date) to authenticated;
grant execute on function public.save_monthly_budget(date,uuid,text,integer) to authenticated;
