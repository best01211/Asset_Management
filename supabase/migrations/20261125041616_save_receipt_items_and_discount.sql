create table public.purchase_receipts (
 user_id uuid not null,
 pending_id uuid not null,
 details jsonb not null check (jsonb_typeof(details)='object'),
 primary key(user_id,pending_id),
 foreign key(user_id,pending_id) references public.pending_transactions(user_id,id)
);
alter table public.purchase_receipts enable row level security;
revoke all on public.purchase_receipts from public,anon,authenticated;
grant select on public.purchase_receipts to authenticated;
create policy purchase_receipts_owner on public.purchase_receipts for select to authenticated
 using (user_id=(select auth.uid()));

create function public.require_open_receipt() returns trigger language plpgsql set search_path = '' as $$
declare
 owner_id uuid := case when tg_op='INSERT' then new.user_id else old.user_id end;
 draft_id uuid := case when tg_op='INSERT' then new.pending_id else old.pending_id end;
begin
 if tg_op='UPDATE' or not exists (
  select 1 from public.pending_transactions p where p.user_id=owner_id and p.id=draft_id
   and p.status='pending_review' for share
 ) then
  raise exception 'RECEIPT_IMMUTABLE' using errcode='55000';
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end;
$$;
create trigger receipt_requires_open_draft before insert or update or delete on public.purchase_receipts
 for each row execute function public.require_open_receipt();
create trigger purchase_receipts_no_truncate before truncate on public.purchase_receipts
 for each statement execute function public.prevent_purchase_reversal_change();

create function public.protect_receipt_allocations() returns trigger language plpgsql set search_path = '' as $$
declare
 owner_id uuid := case when tg_op='INSERT' then new.user_id else old.user_id end;
 draft_id uuid := case when tg_op='INSERT' then new.pending_id else old.pending_id end;
begin
 if exists (select 1 from public.purchase_receipts r where r.user_id=owner_id and r.pending_id=draft_id) then
  raise exception 'RECEIPT_CONTROLS_SPLITS' using errcode='55000';
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end;
$$;
create trigger receipt_controls_purchase_splits before insert or update or delete on public.pending_purchase_splits
 for each row execute function public.protect_receipt_allocations();
revoke all on function public.require_open_receipt(),public.protect_receipt_allocations() from public,anon,authenticated;

create function public.get_purchase_receipt(p_pending_id uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
 uid uuid := auth.uid();
 result jsonb;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 select jsonb_build_object('version',p.version,'status',p.status,'purchase_minor',p.amount_minor::text,
  'confirmed_transaction_id',p.confirmed_transaction_id,'receipt',r.details)
 into result from public.pending_transactions p left join public.purchase_receipts r on r.user_id=p.user_id and r.pending_id=p.id
 where p.user_id=uid and p.id=p_pending_id;
 if not found then raise exception 'PENDING_NOT_FOUND' using errcode='P0002'; end if;
 return result;
end;
$$;

create function public.save_purchase_receipt(p_pending_id uuid,p_version integer,p_receipt jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
 uid uuid := auth.uid();
 draft public.pending_transactions%rowtype;
 previous jsonb;
 receipt jsonb;
 subtotal numeric;
 shipping bigint;
 discount bigint;
 points bigint;
 items jsonb;
 n integer;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_pending_id is null or coalesce(p_version,0)<1 then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 select * into draft from public.pending_transactions p where p.user_id=uid and p.id=p_pending_id for update;
 if not found then raise exception 'PENDING_NOT_FOUND' using errcode='P0002'; end if;
 if draft.status<>'pending_review' or draft.version<>p_version then
  raise exception 'STALE_OR_NOT_REVIEWABLE' using errcode='P0001';
 end if;
 if draft.currency<>'KRW' then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 select r.details into previous from public.purchase_receipts r where r.user_id=uid and r.pending_id=p_pending_id;

 if p_receipt is not null then
  if jsonb_typeof(p_receipt)<>'object' or jsonb_typeof(p_receipt->'items') is distinct from 'array'
   or coalesce(p_receipt->>'source','') not in ('manual','ocr_reviewed')
   or exists (
    select 1 from unnest(array['shipping_minor','discount_minor','points_minor']) field
    where jsonb_typeof(p_receipt->field) is distinct from 'string' or p_receipt->>field !~ '^(0|[1-9][0-9]{0,18})$'
   ) then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
  n := jsonb_array_length(p_receipt->'items');
  if n not between 1 and 100 or exists (
   select 1 from jsonb_array_elements(p_receipt->'items') as item
   where jsonb_typeof(item)<>'object' or jsonb_typeof(item->'label') is distinct from 'string'
    or length(btrim(item->>'label')) not between 1 and 160 or jsonb_typeof(item->'category_id') is distinct from 'string'
    or jsonb_typeof(item->'gross_minor') is distinct from 'string' or item->>'gross_minor' !~ '^[1-9][0-9]{0,18}$'
    or jsonb_typeof(item->'discount_minor') is distinct from 'string' or item->>'discount_minor' !~ '^(0|[1-9][0-9]{0,18})$'
  ) then raise exception 'INVALID_INPUT' using errcode='22023'; end if;

  shipping := (p_receipt->>'shipping_minor')::bigint;
  discount := (p_receipt->>'discount_minor')::bigint;
  points := (p_receipt->>'points_minor')::bigint;
  items := p_receipt->'items';
  select sum((item->>'gross_minor')::bigint::numeric-(item->>'discount_minor')::bigint) into subtotal
  from jsonb_array_elements(items) as item;
  if subtotal<=0 or exists (select 1 from jsonb_array_elements(items) as item
   where (item->>'discount_minor')::bigint>(item->>'gross_minor')::bigint) then
   raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  if subtotal+shipping-discount-points<>draft.amount_minor then
   raise exception 'RECEIPT_TOTAL_MISMATCH' using errcode='22023';
  end if;
  if (select count(distinct item->>'category_id') from jsonb_array_elements(items) as item)>30
   or exists (select 1 from jsonb_array_elements(items) as item where not exists (
    select 1 from public.categories c join public.financial_accounts a on a.user_id=c.user_id and a.id=c.expense_account_id
    where c.user_id=uid and c.id=(item->>'category_id')::uuid and a.kind='expense' and a.currency='KRW'
   )) then raise exception 'RECEIPT_CATEGORY_INVALID' using errcode='22023'; end if;

  -- Rank exact integer remainders, avoiding rounded division.
  with weights as (
   select item,idx,draft.amount_minor::numeric*((item->>'gross_minor')::bigint-(item->>'discount_minor')::bigint) as weighted
   from jsonb_array_elements(items) with ordinality as row_item(item,idx)
  ), ranked as (
   select item,idx,div(weighted,subtotal) as floor_won,
    row_number() over(order by mod(weighted,subtotal) desc,idx) as rank,
    sum(div(weighted,subtotal)) over() as distributed
   from weights
  )
  select jsonb_agg(jsonb_build_object(
   'label',btrim(item->>'label'),'category_id',(item->>'category_id')::uuid,
   'gross_minor',item->>'gross_minor','discount_minor',item->>'discount_minor',
   'net_minor',(floor_won+case when rank<=draft.amount_minor-distributed then 1 else 0 end)::text
  ) order by idx) into items from ranked;
  receipt := jsonb_build_object('source',p_receipt->>'source','shipping_minor',shipping::text,
   'discount_minor',discount::text,'points_minor',points::text,'items',items);
 end if;

 if receipt is not distinct from previous then return public.get_purchase_receipt(p_pending_id); end if;

 -- Remove the previous receipt first so the protected category allocations can be replaced atomically.
 delete from public.purchase_receipts where user_id=uid and pending_id=p_pending_id;
 delete from public.pending_purchase_splits where user_id=uid and pending_id=p_pending_id;
 if receipt is not null then
  insert into public.pending_purchase_splits(user_id,pending_id,category_id,amount_minor)
  select uid,p_pending_id,x.category_id,sum(x.net_minor::bigint)::bigint
  from jsonb_to_recordset(items) as x(category_id uuid,net_minor text)
  where x.net_minor::bigint>0 group by x.category_id;
  insert into public.purchase_receipts(user_id,pending_id,details) values(uid,p_pending_id,receipt);
 end if;
 update public.pending_transactions set version=version+1,updated_at=now() where user_id=uid and id=p_pending_id;
 insert into public.audit_logs(user_id,entity_type,entity_id,action,details)
 values(uid,'pending_transaction',p_pending_id,case when receipt is null then 'receipt_remove' else 'receipt_save' end,
  jsonb_build_object('before_count',coalesce(jsonb_array_length(previous->'items'),0),
   'after_count',coalesce(jsonb_array_length(receipt->'items'),0),'amount_minor',draft.amount_minor::text,'version',p_version+1));
 return public.get_purchase_receipt(p_pending_id);
end;
$$;

revoke all on function public.get_purchase_receipt(uuid),public.save_purchase_receipt(uuid,integer,jsonb) from public,anon;
grant execute on function public.get_purchase_receipt(uuid),public.save_purchase_receipt(uuid,integer,jsonb) to authenticated;
