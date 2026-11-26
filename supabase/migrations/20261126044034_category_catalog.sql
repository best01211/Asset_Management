create table public.category_groups (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null,
 name text not null check(length(trim(name)) between 1 and 80),
 transaction_type text not null check(transaction_type in ('expense','income')),
 system_key text not null,
 sort_order integer not null,
 unique(user_id,system_key),
 unique(user_id,id,transaction_type)
);
alter table public.category_groups enable row level security;
revoke all on public.category_groups from public,anon,authenticated;
grant select on public.category_groups to authenticated;
create policy category_groups_owner_read on public.category_groups
 for select to authenticated using(user_id=(select auth.uid()));

alter table public.categories
 alter column expense_account_id drop not null,
 add column parent_id uuid,
 add column transaction_type text not null default 'expense',
 add column sort_order integer not null default 10 check(sort_order between 0 and 1000000),
 add column is_active boolean not null default true,
 add column system_key text,
 add column is_system boolean generated always as (system_key is not null) stored,
 add column updated_at timestamptz not null default now(),
 add constraint categories_same_type_group foreign key(user_id,parent_id,transaction_type)
  references public.category_groups(user_id,id,transaction_type),
 add constraint category_account_by_type check(
  (transaction_type='expense' and expense_account_id is not null) or
  (transaction_type='income' and expense_account_id is null)),
 add constraint categories_system_key unique(user_id,system_key);
create index category_parent_order on public.categories(user_id,parent_id,sort_order,id);

-- Historic category IDs remain valid, including records created by the older API.
insert into public.category_groups(user_id,name,transaction_type,system_key,sort_order)
 select distinct user_id,'기존 지출','expense','legacy',1000 from public.categories;
update public.categories c set parent_id=g.id
 from public.category_groups g where g.user_id=c.user_id and g.system_key='legacy';
alter table public.categories alter column parent_id set not null;

create function private.complete_expense_category() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.parent_id is null then
  insert into public.category_groups(user_id,name,transaction_type,system_key,sort_order)
  values(new.user_id,'기존 지출','expense','legacy',1000) on conflict(user_id,system_key) do nothing;
  select id into new.parent_id from public.category_groups where user_id=new.user_id and system_key='legacy';
 end if;
 return new;
end;
$$;
create table public.transaction_category_overrides (
 user_id uuid not null,
 transaction_id uuid not null,
 source_category_id uuid not null,
 category_id uuid not null,
 updated_at timestamptz not null default now(),
 primary key(user_id,transaction_id,source_category_id),
 foreign key(user_id,transaction_id) references public.transactions(user_id,id),
 foreign key(user_id,source_category_id) references public.categories(user_id,id),
 foreign key(user_id,category_id) references public.categories(user_id,id)
);
alter table public.transaction_category_overrides enable row level security;
revoke all on public.transaction_category_overrides from public,anon,authenticated;
grant select on public.transaction_category_overrides to authenticated;
create policy category_overrides_owner_read on public.transaction_category_overrides
 for select to authenticated using(user_id=(select auth.uid()));

create function private.move_transaction_category(p_id uuid,p_source uuid,p_previous uuid,p_target uuid) returns void
language plpgsql security definer set search_path='' as $$
declare
 uid uuid:=auth.uid();
 current_id uuid;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_id is null or p_source is null or p_previous is null or p_target is null
  then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 perform 1 from public.transactions where user_id=uid and id=p_id
  and kind in ('purchase_cash','purchase_debit','purchase_credit','transfer_fee') for update;
 if not found or not (
  exists(select 1 from public.transaction_splits where user_id=uid and transaction_id=p_id and category_id=p_source)
  or exists(select 1 from public.transfer_fees where user_id=uid and transaction_id=p_id and category_id=p_source)
 ) then raise exception 'TRANSACTION_CATEGORY_NOT_FOUND' using errcode='P0002'; end if;
 perform 1 from public.categories where user_id=uid and id=p_target and transaction_type='expense' and is_active for share;
 if not found then raise exception 'CATEGORY_UNAVAILABLE' using errcode='22023'; end if;
 select category_id into current_id from public.transaction_category_overrides
  where user_id=uid and transaction_id=p_id and source_category_id=p_source;
 current_id:=coalesce(current_id,p_source);
 if current_id=p_target then return; end if;
 if current_id<>p_previous then raise exception 'STALE_CATEGORY' using errcode='23505'; end if;
 if p_target=p_source then
  delete from public.transaction_category_overrides where user_id=uid and transaction_id=p_id and source_category_id=p_source;
 else
  insert into public.transaction_category_overrides(user_id,transaction_id,source_category_id,category_id)
  values(uid,p_id,p_source,p_target)
  on conflict(user_id,transaction_id,source_category_id) do update
   set category_id=excluded.category_id,updated_at=now();
 end if;
 insert into public.audit_logs(user_id,entity_type,entity_id,action,details)
 values(uid,'transaction',p_id,'transaction_category_changed',
  jsonb_build_object('source_category_id',p_source,'from_category_id',current_id,'to_category_id',p_target));
end;
$$;
create function public.move_transaction_category(p_id uuid,p_source uuid,p_previous uuid,p_target uuid) returns void
language sql set search_path='' as $$ select private.move_transaction_category(p_id,p_source,p_previous,p_target) $$;
revoke all on function private.move_transaction_category(uuid,uuid,uuid,uuid),
 public.move_transaction_category(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function private.move_transaction_category(uuid,uuid,uuid,uuid),
 public.move_transaction_category(uuid,uuid,uuid,uuid) to authenticated;

create view public.reporting_purchase_categories with (security_invoker=true) as
 select s.user_id,s.transaction_id,coalesce(o.category_id,s.category_id) as category_id,
  sum(s.amount_minor)::bigint as amount_minor
 from public.transaction_splits s left join public.transaction_category_overrides o
 on o.user_id=s.user_id and o.transaction_id=s.transaction_id and o.source_category_id=s.category_id
 group by s.user_id,s.transaction_id,coalesce(o.category_id,s.category_id);
create view public.reporting_refund_categories with (security_invoker=true) as
 select r.user_id,r.transaction_id,coalesce(o.category_id,r.category_id) as category_id,
  sum(r.amount_minor)::bigint as amount_minor
 from public.refund_allocations r join public.account_movements m
 on m.user_id=r.user_id and m.transaction_id=r.transaction_id
 left join public.transaction_category_overrides o
 on o.user_id=r.user_id and o.transaction_id=m.original_purchase_id and o.source_category_id=r.category_id
 group by r.user_id,r.transaction_id,coalesce(o.category_id,r.category_id);
create view public.reporting_fee_categories with (security_invoker=true) as
 select f.user_id,f.transaction_id,coalesce(o.category_id,f.category_id) as category_id
 from public.transfer_fees f left join public.transaction_category_overrides o
 on o.user_id=f.user_id and o.transaction_id=f.transaction_id and o.source_category_id=f.category_id;
revoke all on public.reporting_purchase_categories,public.reporting_refund_categories,public.reporting_fee_categories
 from public,anon,authenticated;
grant select on public.reporting_purchase_categories,public.reporting_refund_categories,public.reporting_fee_categories to authenticated;

create function public.category_usage(p_id uuid) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object(
  'pending',(select count(*) from public.pending_transactions p where p.user_id=c.user_id
    and p.status in ('pending_review','duplicate_suspected') and (p.category_id=c.id or exists(
     select 1 from public.pending_purchase_splits s where s.user_id=p.user_id and s.pending_id=p.id and s.category_id=c.id))),
  'confirmed',(select count(*) from (
    select s.transaction_id from public.reporting_purchase_categories s where s.user_id=c.user_id and s.category_id=c.id
    union select s.transaction_id from public.reporting_refund_categories s where s.user_id=c.user_id and s.category_id=c.id
    union select s.transaction_id from public.reporting_fee_categories s where s.user_id=c.user_id and s.category_id=c.id
  ) usage),
  'budgets',(select count(*) from public.monthly_budgets b where b.user_id=c.user_id and b.category_id=c.id),
  'rules',(select count(*) from public.merchant_category_rules r where r.user_id=c.user_id and r.category_id=c.id)
 )
 from public.categories c where c.user_id=(select auth.uid()) and c.id=p_id
$$;
revoke all on function public.category_usage(uuid) from public,anon;
grant execute on function public.category_usage(uuid) to authenticated;

create function private.save_catalog_category(p_id uuid,p_parent uuid,p_name text,p_sort integer,p_active boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare
 uid uuid:=auth.uid();
 kind text;
 current_category public.categories%rowtype;
 expense uuid;
 new_id uuid;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_name is null or length(trim(p_name)) not between 1 and 80 or p_sort is null
  or p_sort not between 0 and 1000000 or p_active is null
  then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('category-catalog:' || uid::text,0));
 select transaction_type into kind from public.category_groups where user_id=uid and id=p_parent;
 if not found then raise exception 'CATEGORY_GROUP_NOT_FOUND' using errcode='P0002'; end if;
 if p_id is not null then
  select * into current_category from public.categories where user_id=uid and id=p_id for update;
  if not found then raise exception 'CATEGORY_NOT_FOUND' using errcode='P0002'; end if;
  if current_category.parent_id<>p_parent or (current_category.is_system and not p_active)
   then raise exception 'CATEGORY_PROTECTED' using errcode='22023'; end if;
  if current_category.name=trim(p_name) and current_category.sort_order=p_sort and current_category.is_active=p_active then
   return p_id;
  end if;
 end if;
 if exists(select 1 from public.categories where user_id=uid and parent_id=p_parent
  and lower(trim(name))=lower(trim(p_name)) and id is distinct from p_id)
  then raise exception 'CATEGORY_NAME_EXISTS' using errcode='23505'; end if;

 if p_id is null then
  if kind='expense' then
   insert into public.financial_accounts(user_id,name,kind,currency)
   values(uid,trim(p_name),'expense','KRW') returning id into expense;
  end if;
  insert into public.categories(user_id,parent_id,transaction_type,name,expense_account_id,sort_order,is_active)
  values(uid,p_parent,kind,trim(p_name),expense,p_sort,p_active) returning id into new_id;
  return new_id;
 end if;

 update public.categories set name=trim(p_name),sort_order=p_sort,is_active=p_active,updated_at=now()
 where user_id=uid and id=p_id;
 return p_id;
end;
$$;
create function public.save_catalog_category(p_id uuid,p_parent uuid,p_name text,p_sort integer,p_active boolean) returns uuid
language sql set search_path='' as $$ select private.save_catalog_category(p_id,p_parent,p_name,p_sort,p_active) $$;
revoke all on function private.save_catalog_category(uuid,uuid,text,integer,boolean),
 public.save_catalog_category(uuid,uuid,text,integer,boolean) from public,anon,authenticated;
grant execute on function private.save_catalog_category(uuid,uuid,text,integer,boolean),
 public.save_catalog_category(uuid,uuid,text,integer,boolean) to authenticated;

create function private.rename_catalog_group(p_id uuid,p_name text) returns uuid
language plpgsql security definer set search_path='' as $$
declare
 uid uuid:=auth.uid();
 kind text;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_name is null or length(trim(p_name)) not between 1 and 80
  then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('category-catalog:' || uid::text,0));
 select transaction_type into kind from public.category_groups where user_id=uid and id=p_id;
 if not found then raise exception 'CATEGORY_GROUP_NOT_FOUND' using errcode='P0002'; end if;
 if exists(select 1 from public.category_groups where user_id=uid and transaction_type=kind
  and lower(trim(name))=lower(trim(p_name)) and id<>p_id)
  then raise exception 'CATEGORY_NAME_EXISTS' using errcode='23505'; end if;
 update public.category_groups set name=trim(p_name) where user_id=uid and id=p_id;
 return p_id;
end;
$$;
create function public.rename_catalog_group(p_id uuid,p_name text) returns uuid
language sql set search_path='' as $$ select private.rename_catalog_group(p_id,p_name) $$;
revoke all on function private.rename_catalog_group(uuid,text),public.rename_catalog_group(uuid,text) from public,anon,authenticated;
grant execute on function private.rename_catalog_group(uuid,text),public.rename_catalog_group(uuid,text) to authenticated;

create function private.require_active_expense_category() returns trigger
language plpgsql set search_path='' as $$
begin
 if tg_op='UPDATE' and new.category_id=old.category_id then return new; end if;
 if not exists(select 1 from public.categories where user_id=new.user_id and id=new.category_id
  and transaction_type='expense' and is_active) then raise exception 'CATEGORY_UNAVAILABLE' using errcode='22023'; end if;
 return new;
end;
$$;
revoke all on function private.require_active_expense_category() from public,anon,authenticated;
create trigger pending_category_available before insert or update of category_id on public.pending_transactions
 for each row execute function private.require_active_expense_category();
create trigger pending_split_category_available before insert or update of category_id on public.pending_purchase_splits
 for each row execute function private.require_active_expense_category();
create trigger fee_category_available before insert or update of category_id on public.transfer_fees
 for each row execute function private.require_active_expense_category();
create trigger merchant_rule_category_available before insert or update of category_id on public.merchant_category_rules
 for each row execute function private.require_active_expense_category();
revoke all on function private.complete_expense_category() from public,anon,authenticated;
create trigger complete_expense_category before insert on public.categories
 for each row execute function private.complete_expense_category();
revoke insert on public.categories from authenticated;
revoke update(name) on public.categories from authenticated;
grant insert(user_id,name,expense_account_id) on public.categories to authenticated;

create table public.tags (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null,
 name text not null check(name=trim(name) and length(name) between 1 and 24),
 created_at timestamptz not null default now(),
 unique(user_id,name)
);
alter table public.tags enable row level security;
revoke all on public.tags from public,anon,authenticated;
grant select on public.tags to authenticated;
create policy tags_owner_read on public.tags for select to authenticated using(user_id=(select auth.uid()));
insert into public.tags(user_id,name)
 select distinct a.user_id,tag from public.transaction_annotations a cross join lateral unnest(a.tags) tag
 where length(tag) between 1 and 24 and tag=trim(tag)
 on conflict(user_id,name) do nothing;

create function private.initialize_category_catalog(p_user uuid) returns void
language plpgsql security definer set search_path='' as $$
declare
 spec record;
 child record;
 parent uuid;
 account uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('category-catalog:' || p_user::text,0));
 if exists(select 1 from public.category_groups where user_id=p_user and system_key='food') then return; end if;
 for spec in select * from (values
  ('food','식비','expense',10,array['외식','카페·음료','간식','배달','식료품','주류']),
  ('housing','주거·공과금','expense',20,array['월세·주거비','관리비','전기·가스·수도','통신비','보험료','기타 주거비']),
  ('transport','교통','expense',30,array['대중교통','택시','주유·충전','주차·통행료','공유 이동수단','기타 교통비']),
  ('shopping','생활·쇼핑','expense',40,array['생필품','의류·패션','미용·관리','전자기기','가구·생활용품','잡화','기타 쇼핑']),
  ('health','건강·의료','expense',50,array['병원·진료','약국·의약품','건강검진','건강용품','영양제','기타 의료비']),
  ('education','교육·개발','expense',60,array['강의·교육','자격증·시험','도서·교재','소프트웨어·개발 도구','학습 용품','기타 교육비']),
  ('leisure','취미·여가','expense',70,array['운동·스포츠','문화생활','영화·공연','게임','콘텐츠 구독','취미 용품','기타 여가비']),
  ('travel','여행','expense',80,array['숙박','여행 교통','여행 활동','여행 식비','여행 쇼핑','기타 여행비']),
  ('gifts','선물·경조','expense',90,array['선물','기념일','축의금','부의금','가족 지원','기타 경조비']),
  ('fees','금융비용','expense',100,array['대출이자','금융 수수료','금융 관련 세금','기타 금융비용']),
  ('other','기타','expense',110,array['미분류','기타 지출']),
  ('work','근로·사업 소득','income',120,array['급여','상여금','아르바이트','사업·프리랜서 소득','기타 근로소득']),
  ('investment','금융·투자 수익','income',130,array['이자','배당금','실현 투자수익','기타 금융수익']),
  ('other_income','기타 수입','income',140,array['용돈','지원금','상금·포상금','중고 거래 수입','캐시백·리워드','기타 수입','미분류 수입'])
 ) as v(key,name,kind,rank,children) loop
  insert into public.category_groups(user_id,name,transaction_type,system_key,sort_order)
  values(p_user,spec.name,spec.kind,spec.key,spec.rank) returning id into parent;
  for child in select * from unnest(spec.children) with ordinality as v(name,position) loop
   account := null;
   if spec.kind='expense' then
    insert into public.financial_accounts(user_id,name,kind,currency)
    values(p_user,child.name,'expense','KRW') returning id into account;
   end if;
   insert into public.categories(user_id,parent_id,transaction_type,name,expense_account_id,system_key,sort_order)
   values(p_user,parent,spec.kind,child.name,account,spec.key || '/' || child.position,(child.position*10)::integer);
  end loop;
 end loop;
 insert into public.tags(user_id,name)
 select p_user, name from unnest(array['데이트','친구·모임','가족','러닝','여행','업무','학습','AI 도구','선물','특별 지출']) name
 on conflict(user_id,name) do nothing;
end;
$$;
revoke all on function private.initialize_category_catalog(uuid) from public,anon,authenticated;

create function private.initialize_my_category_catalog() returns void
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid();
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if not exists(select 1 from public.category_groups where user_id=uid and system_key='food') then
  perform private.initialize_category_catalog(uid);
 end if;
end;
$$;
create function public.initialize_category_catalog() returns void language sql set search_path='' as $$
 select private.initialize_my_category_catalog()
$$;
revoke all on function private.initialize_my_category_catalog(),public.initialize_category_catalog() from public,anon,authenticated;
grant execute on function private.initialize_my_category_catalog(),public.initialize_category_catalog() to authenticated;

do $$
declare owner_id uuid;
begin
 for owner_id in select user_id from public.financial_accounts union select user_id from public.categories loop
  perform private.initialize_category_catalog(owner_id);
 end loop;
end;
$$;
create function private.register_annotation_tags() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into public.tags(user_id,name) select new.user_id,tag from unnest(new.tags) tag
  where tag=trim(tag) and length(tag) between 1 and 24
 on conflict(user_id,name) do nothing;
 return new;
end;
$$;
revoke all on function private.register_annotation_tags() from public,anon,authenticated;
create trigger annotation_tags_register after insert or update of tags on public.transaction_annotations
 for each row execute function private.register_annotation_tags();

create function private.save_catalog_tag(p_id uuid,p_name text) returns uuid
language plpgsql security definer set search_path='' as $$
declare
 uid uuid:=auth.uid();
 previous text;
 result uuid;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if (p_id is null and p_name is null) or (p_name is not null and (length(trim(p_name)) not between 1 and 24
  or strpos(p_name,',')>0)) then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('tag-catalog:' || uid::text,0));
 if p_id is null then
  insert into public.tags(user_id,name) values(uid,trim(p_name)) on conflict(user_id,name) do nothing returning id into result;
  if result is null then select id into result from public.tags where user_id=uid and name=trim(p_name); end if;
  return result;
 end if;
 select name into previous from public.tags where user_id=uid and id=p_id for update;
 if not found then raise exception 'TAG_NOT_FOUND' using errcode='P0002'; end if;
 if previous=trim(p_name) then return p_id; end if;
 if p_name is null then
  delete from public.tags where user_id=uid and id=p_id;
 else
  update public.tags set name=trim(p_name) where user_id=uid and id=p_id;
 end if;
 with changed as (
  update public.transaction_annotations a
  set tags=case when p_name is null then array_remove(a.tags,previous)
   else array_replace(a.tags,previous,trim(p_name)) end,version=a.version+1
  where a.user_id=uid and previous=any(a.tags)
  returning transaction_id,version
 )
 insert into public.audit_logs(user_id,entity_type,entity_id,action,details)
 select uid,'transaction',transaction_id,'transaction_tags_updated',jsonb_build_object('version',version) from changed;
 return p_id;
end;
$$;
create function public.save_catalog_tag(p_id uuid,p_name text) returns uuid
language sql set search_path='' as $$ select private.save_catalog_tag(p_id,p_name) $$;
revoke all on function private.save_catalog_tag(uuid,text),public.save_catalog_tag(uuid,text) from public,anon,authenticated;
grant execute on function private.save_catalog_tag(uuid,text),public.save_catalog_tag(uuid,text) to authenticated;

create or replace function public.match_merchant_category(p_merchant text) returns uuid
language sql stable set search_path='' as $$
 select r.category_id from public.merchant_category_rules r
 join public.categories c on c.user_id=r.user_id and c.id=r.category_id and c.is_active and c.transaction_type='expense'
 join public.financial_accounts a on a.user_id=c.user_id and a.id=c.expense_account_id
 where r.user_id=(select auth.uid()) and r.merchant_key=lower(trim(p_merchant)) and a.kind='expense' and a.currency='KRW'
$$;

create function public.suggest_expense_category(p_merchant text,p_memo text default null) returns jsonb
language plpgsql stable set search_path='' as $$
declare
 uid uuid:=auth.uid();
 matched uuid;
 hits integer;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_merchant is null or length(trim(p_merchant)) not between 1 and 200 or length(p_memo)>1000
  then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 matched:=public.match_merchant_category(p_merchant);
 if matched is not null then
  return jsonb_build_object('category_id',matched,'source','merchant_rule','confidence','rule');
 end if;

 with latest as (
  select t.id,t.user_id from public.transactions t
  left join public.transaction_annotations a on a.user_id=t.user_id and a.transaction_id=t.id
  where t.user_id=uid and lower(trim(t.merchant))=lower(trim(p_merchant))
   and t.kind in ('purchase_cash','purchase_credit','purchase_debit')
   and (nullif(trim(p_memo),'') is null or lower(trim(a.memo))=lower(trim(p_memo)))
   and not exists(select 1 from public.purchase_reversals r where r.user_id=uid and r.original_purchase_id=t.id)
  order by t.occurred_at desc,t.id desc limit 10
 ), eligible as (
  select t.id,(array_agg(s.category_id))[1] as category_id from latest t
  join public.reporting_purchase_categories s on s.user_id=t.user_id and s.transaction_id=t.id
  group by t.id having count(*)=1
 )
 select (array_agg(e.category_id))[1],count(*) into matched,hits
 from eligible e join public.categories c on c.user_id=uid and c.id=e.category_id
 where c.is_active and c.system_key is distinct from 'other/1'
 having count(distinct e.category_id)=1 and count(*)=(select count(*) from latest);

 if hits>=2 then return jsonb_build_object('category_id',matched,'source','confirmed_history','confidence','consistent'); end if;
 select id into matched from public.categories where user_id=uid and system_key='other/1';
 return jsonb_build_object('category_id',matched,'source','unclassified','confidence','none');
end;
$$;
revoke all on function public.suggest_expense_category(text,text) from public,anon;
grant execute on function public.suggest_expense_category(text,text) to authenticated;

-- Only category attribution changes here. Gross totals and account balances use original ledger entries.
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
  from spending p join public.reporting_purchase_categories s on s.user_id=uid and s.transaction_id=p.purchase_id
  union all
  select r.category_id,-r.amount_minor from activity a
  join public.reporting_refund_categories r on r.user_id=uid and r.transaction_id=a.id where a.kind='purchase_refund'
  union all
  select f.category_id,a.amount_minor from activity a
  join public.reporting_fee_categories f on f.user_id=uid and f.transaction_id=a.id where a.kind='transfer_fee'
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


-- Serialize annotation edits with tag renames before checking the annotation version.
create or replace function private.save_transaction_annotation(p_id uuid,p_version integer,p_memo text,p_tags text[]) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 uid uuid := auth.uid();
 current_annotation public.transaction_annotations%rowtype;
 saved public.transaction_annotations%rowtype;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_version is null or p_version<0 or p_version>=2147483647 or p_memo is null or length(p_memo)>1000 or p_tags is null
  or cardinality(p_tags)>10 or coalesce(array_ndims(p_tags),1)<>1
  or exists(select 1 from unnest(p_tags) as tag where tag is null or tag<>trim(tag) or length(tag) not between 1 and 24)
  then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('tag-catalog:' || uid::text,0));
 perform 1 from public.transactions where user_id=uid and id=p_id for update;
 if not found then raise exception 'TRANSACTION_NOT_FOUND' using errcode='P0002'; end if;
 select * into current_annotation from public.transaction_annotations where user_id=uid and transaction_id=p_id;
 if coalesce(current_annotation.version,0)<>p_version then
  raise exception 'STALE_ANNOTATION' using errcode='23505';
 end if;
 if current_annotation.memo=p_memo and current_annotation.tags=p_tags then
  return jsonb_build_object('memo',current_annotation.memo,'tags',current_annotation.tags,'version',current_annotation.version);
 end if;
 insert into public.transaction_annotations as annotation(user_id,transaction_id,memo,tags,version)
 values(uid,p_id,p_memo,p_tags,p_version+1)
 on conflict(user_id,transaction_id) do update set memo=excluded.memo,tags=excluded.tags,version=excluded.version
 returning annotation.* into saved;
 insert into public.audit_logs(user_id,entity_type,entity_id,action,details)
 values(uid,'transaction',p_id,'transaction_annotation_saved',jsonb_build_object('version',saved.version));
 return jsonb_build_object('memo',saved.memo,'tags',saved.tags,'version',saved.version);
end;
$$;
