create table public.merchant_category_rules (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null,
 merchant text not null check (length(trim(merchant)) between 1 and 200),
 merchant_key text generated always as (lower(trim(merchant))) stored,
 category_id uuid not null,
 unique(user_id,merchant_key),
 foreign key(user_id,category_id) references public.categories(user_id,id)
);

alter table public.merchant_category_rules enable row level security;
revoke all on public.merchant_category_rules from public,anon,authenticated;
grant select,insert,update(merchant,category_id),delete on public.merchant_category_rules to authenticated;
create policy merchant_rule_read on public.merchant_category_rules for select to authenticated
 using ((select auth.uid())=user_id);
create policy merchant_rule_insert on public.merchant_category_rules for insert to authenticated
 with check ((select auth.uid())=user_id);
create policy merchant_rule_update on public.merchant_category_rules for update to authenticated
 using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
create policy merchant_rule_delete on public.merchant_category_rules for delete to authenticated
 using ((select auth.uid())=user_id);

create function public.match_merchant_category(p_merchant text) returns uuid
language sql stable set search_path = '' as $$
 select r.category_id from public.merchant_category_rules r
 join public.categories c on c.user_id=r.user_id and c.id=r.category_id
 join public.financial_accounts a on a.user_id=c.user_id and a.id=c.expense_account_id
 where r.user_id=(select auth.uid()) and r.merchant_key=lower(trim(p_merchant)) and a.kind='expense' and a.currency='KRW';
$$;

create function public.save_merchant_category_rule(p_merchant text,p_category_id uuid)
returns uuid language plpgsql set search_path = '' as $$
declare
 uid uuid := auth.uid();
 name text := trim(p_merchant);
 rule_id uuid;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if name is null or length(name) not between 1 and 200 then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;
 if p_category_id is null then
  delete from public.merchant_category_rules where user_id=uid and merchant_key=lower(name) returning id into rule_id;
  return rule_id;
 end if;
 if not exists (
  select 1 from public.categories c join public.financial_accounts a on a.user_id=c.user_id and a.id=c.expense_account_id
  where c.user_id=uid and c.id=p_category_id and a.kind='expense' and a.currency='KRW'
 ) then raise exception 'RULE_CATEGORY_NOT_FOUND' using errcode='P0002'; end if;
 insert into public.merchant_category_rules(user_id,merchant,category_id) values(uid,name,p_category_id)
 on conflict(user_id,merchant_key) do update set merchant=excluded.merchant,category_id=excluded.category_id
 returning id into rule_id;
 return rule_id;
end;
$$;
revoke all on function public.match_merchant_category(text) from public,anon;
revoke all on function public.save_merchant_category_rule(text,uuid) from public,anon;
grant execute on function public.match_merchant_category(text) to authenticated;
grant execute on function public.save_merchant_category_rule(text,uuid) to authenticated;
