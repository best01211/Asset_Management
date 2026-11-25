create table public.card_installment_plans (
 user_id uuid not null,
 purchase_id uuid not null,
 version integer not null default 1 check (version>0),
 first_month date,
 payment_count integer,
 principal_minor bigint,
 fee_minor bigint,
 refunds_at_save_minor bigint,
 primary key(user_id,purchase_id),
 foreign key(user_id,purchase_id) references public.transactions(user_id,id),
 check (
  (first_month is null and payment_count is null and principal_minor is null and fee_minor is null and refunds_at_save_minor is null)
  or (first_month is not null and first_month between date '1900-01-01' and date '9998-12-01' and extract(day from first_month)=1
   and payment_count is not null and payment_count between 2 and 60
   and principal_minor is not null and principal_minor>=payment_count
   and fee_minor is not null and fee_minor>=0 and refunds_at_save_minor is not null and refunds_at_save_minor>=0
   and first_month+make_interval(months=>payment_count-1)<date '9999-01-01')
 )
);

alter table public.card_installment_plans enable row level security;
revoke all on public.card_installment_plans from public,anon,authenticated;
grant select on public.card_installment_plans to authenticated;
create policy card_installment_plans_owner on public.card_installment_plans for select to authenticated
 using (user_id=(select auth.uid()));
create index card_installment_plans_first_month on public.card_installment_plans(user_id,first_month)
 where first_month is not null;

-- The purchase totals and refund status are shared by editing and forecasting.
create function public.get_card_installment_plan(p_purchase_id uuid)
returns jsonb language sql stable set search_path = '' as $$
 select jsonb_build_object(
  'purchase_id',t.id,'merchant',t.merchant,'purchase_month',to_char(t.occurred_at at time zone 'Asia/Seoul','YYYY-MM'),
  'available_minor',(t.amount_minor-refunds.total)::text,'reversed',r.transaction_id is not null,
  'version',coalesce(p.version,0),'first_month',to_char(p.first_month,'YYYY-MM'),'payment_count',p.payment_count,
  'principal_minor',p.principal_minor::text,'fee_minor',p.fee_minor::text,
  'needs_review',coalesce(p.refunds_at_save_minor<>refunds.total,false))
 from public.transactions t
 left join public.card_installment_plans p on p.user_id=t.user_id and p.purchase_id=t.id
 left join public.purchase_reversals r on r.user_id=t.user_id and r.original_purchase_id=t.id
 cross join lateral (
  select coalesce(sum(refund.amount_minor),0) as total
  from public.account_movements movement
  join public.transactions refund on refund.user_id=movement.user_id and refund.id=movement.transaction_id and refund.kind='purchase_refund'
  where movement.user_id=t.user_id and movement.original_purchase_id=t.id
 ) refunds
 where t.user_id=(select auth.uid()) and t.id=p_purchase_id and t.kind='purchase_credit' and t.currency='KRW'
$$;

create function public.save_card_installment_plan(
 p_purchase_id uuid,p_version integer,p_first_month date,p_payment_count integer,p_principal_minor text,p_fee_minor text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
 uid uuid := auth.uid();
 original record;
 prior public.card_installment_plans%rowtype;
 refunded bigint;
 principal bigint;
 fee bigint;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_purchase_id is null or p_version is null or p_version<0
  or (p_first_month is null and (p_payment_count is not null or p_principal_minor is not null or p_fee_minor is not null))
  or (p_first_month is not null and (p_payment_count is null or p_payment_count not between 2 and 60
   or p_principal_minor is null or p_principal_minor !~ '^[1-9][0-9]{0,18}$'
   or p_fee_minor is null or p_fee_minor !~ '^(0|[1-9][0-9]{0,18})$'
   or p_first_month not between date '1900-01-01' and date '9998-12-01' or extract(day from p_first_month)<>1)) then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;

 -- Share the row lock with refunds and reversals.
 select t.id,t.amount_minor,date_trunc('month',t.occurred_at at time zone 'Asia/Seoul')::date as purchase_month into original
 from public.transactions t where t.user_id=uid and t.id=p_purchase_id
  and t.kind='purchase_credit' and t.currency='KRW' for update;
 if not found then raise exception 'INSTALLMENT_PURCHASE_NOT_FOUND' using errcode='P0002'; end if;
 if exists (select 1 from public.purchase_reversals r where r.user_id=uid and r.original_purchase_id=p_purchase_id) then
  raise exception 'PURCHASE_ALREADY_REVERSED' using errcode='23514';
 end if;

 select * into prior from public.card_installment_plans p where p.user_id=uid and p.purchase_id=p_purchase_id;
 if p_version<>coalesce(prior.version,0) then
  raise exception 'INSTALLMENT_VERSION_CONFLICT' using errcode='23505';
 end if;

 if p_first_month is not null then
  if p_first_month<original.purchase_month or p_first_month+make_interval(months=>p_payment_count-1)>=date '9999-01-01' then
   raise exception 'INSTALLMENT_MONTH_INVALID' using errcode='22023';
  end if;
  principal := p_principal_minor::bigint;
  fee := p_fee_minor::bigint;
  select coalesce(sum(t.amount_minor),0) into refunded from public.account_movements m
   join public.transactions t on t.user_id=m.user_id and t.id=m.transaction_id and t.kind='purchase_refund'
   where m.user_id=uid and m.original_purchase_id=p_purchase_id;
  if principal<p_payment_count or principal>original.amount_minor-refunded then
   raise exception 'INSTALLMENT_PRINCIPAL_INVALID' using errcode='22023';
  end if;
 end if;

 if (prior.first_month,prior.payment_count,prior.principal_minor,prior.fee_minor,prior.refunds_at_save_minor)
  is distinct from (p_first_month,p_payment_count,principal,fee,refunded) then
  insert into public.card_installment_plans(user_id,purchase_id,first_month,payment_count,principal_minor,fee_minor,refunds_at_save_minor)
  values(uid,p_purchase_id,p_first_month,p_payment_count,principal,fee,refunded)
  on conflict(user_id,purchase_id) do update set version=public.card_installment_plans.version+1,
   first_month=excluded.first_month,payment_count=excluded.payment_count,principal_minor=excluded.principal_minor,
   fee_minor=excluded.fee_minor,refunds_at_save_minor=excluded.refunds_at_save_minor;
 end if;
 return public.get_card_installment_plan(p_purchase_id);
end;
$$;

create function public.list_card_installments(p_month date) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
 uid uuid := auth.uid();
 result jsonb;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_month is null or p_month not between date '1900-01-01' and date '9998-12-01' or extract(day from p_month)<>1 then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;
 with planned as (
  select p.purchase_id,t.merchant,a.name as account_name,p.payment_count,
   ((extract(year from p_month)-extract(year from p.first_month))*12
     +extract(month from p_month)-extract(month from p.first_month)+1)::integer as payment_number,
   p.principal_minor,p.fee_minor,(public.get_card_installment_plan(p.purchase_id)->>'needs_review')::boolean as needs_review
  from public.card_installment_plans p
  join public.transactions t on t.user_id=p.user_id and t.id=p.purchase_id
  join public.pending_transactions purchase on purchase.user_id=t.user_id and purchase.id=t.source_pending_id
  join public.financial_accounts a on a.user_id=purchase.user_id and a.id=purchase.payment_account_id
  where p.user_id=uid and p.first_month between (p_month-interval '59 months')::date and p_month
   and p_month<p.first_month+make_interval(months=>p.payment_count)
   and not exists (select 1 from public.purchase_reversals r where r.user_id=p.user_id and r.original_purchase_id=p.purchase_id)
 )
 select coalesce(jsonb_agg(jsonb_build_object(
  'purchase_id',purchase_id,'merchant',merchant,'account_name',account_name,
  'payment_number',payment_number,'payment_count',payment_count,'needs_review',needs_review,
  'principal_minor',case when not needs_review then
   (principal_minor/payment_count + case when payment_number<=mod(principal_minor,payment_count) then 1 else 0 end)::text end,
  'fee_minor',case when not needs_review then
   (fee_minor/payment_count + case when payment_number<=mod(fee_minor,payment_count) then 1 else 0 end)::text end
 ) order by account_name,merchant,purchase_id),'[]'::jsonb) into result from planned;
 return result;
end;
$$;

revoke all on function public.get_card_installment_plan(uuid),public.save_card_installment_plan(uuid,integer,date,integer,text,text),
 public.list_card_installments(date) from public,anon;
grant execute on function public.get_card_installment_plan(uuid),public.save_card_installment_plan(uuid,integer,date,integer,text,text),
 public.list_card_installments(date) to authenticated;
