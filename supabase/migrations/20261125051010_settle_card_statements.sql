create table public.card_statements (
 user_id uuid not null,
 id uuid not null default gen_random_uuid(),
 card_id uuid not null,
 statement_month date not null check(extract(day from statement_month)=1),
 due_on date not null,
 billed_minor bigint not null check(billed_minor>=0),
 benefit_minor bigint,
 source text not null check(length(source) between 1 and 200),
 primary key(user_id,id),
 unique(user_id,card_id,statement_month),
 foreign key(user_id,card_id) references public.financial_accounts(user_id,id),
 check(benefit_minor is null or benefit_minor>=0)
);
create table public.card_statement_payments (
 user_id uuid not null,
 statement_id uuid not null,
 payment_id uuid not null,
 amount_minor bigint not null check(amount_minor>0),
 primary key(user_id,statement_id,payment_id),
 foreign key(user_id,statement_id) references public.card_statements(user_id,id),
 foreign key(user_id,payment_id) references public.account_movements(user_id,transaction_id)
);
create index card_statement_payments_by_payment on public.card_statement_payments(user_id,payment_id);
alter table public.card_statements enable row level security;
alter table public.card_statement_payments enable row level security;
revoke all on public.card_statements,public.card_statement_payments from public,anon,authenticated;
grant select on public.card_statements,public.card_statement_payments to authenticated;
create policy card_statements_owner on public.card_statements for select to authenticated using(user_id=(select auth.uid()));
create policy card_statement_payments_owner on public.card_statement_payments for select to authenticated using(user_id=(select auth.uid()));

create function public.register_card_statement(p_card_id uuid,p_month date,p_due_on date,p_billed_minor text,p_benefit_minor text,p_source text)
returns uuid language plpgsql security definer set search_path='' as $$
declare
 uid uuid := auth.uid();
 row_before public.card_statements%rowtype;
 result uuid;
 billed bigint;
 benefit bigint;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_month is null or not isfinite(p_month) or extract(day from p_month)<>1
  or p_due_on is null or not isfinite(p_due_on) or p_due_on<p_month
  or p_billed_minor is null or p_billed_minor !~ '^(0|[1-9][0-9]{0,18})$'
  or (p_benefit_minor is not null and p_benefit_minor !~ '^(0|[1-9][0-9]{0,18})$')
  or p_source is null or length(btrim(p_source)) not between 1 and 200 then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;
 billed := p_billed_minor::bigint;
 benefit := p_benefit_minor::bigint;
 perform 1 from public.financial_accounts where user_id=uid and id=p_card_id and kind='liability' and currency='KRW' for update;
 if not found then raise exception 'CARD_NOT_FOUND' using errcode='P0002'; end if;
 select * into row_before from public.card_statements where user_id=uid and card_id=p_card_id and statement_month=p_month;
 if found then
  if (row_before.due_on,row_before.billed_minor,row_before.benefit_minor,row_before.source)
   is distinct from (p_due_on,billed,benefit,btrim(p_source)) then raise exception 'STATEMENT_EXISTS' using errcode='23505'; end if;
  return row_before.id;
 end if;
 insert into public.card_statements(user_id,card_id,statement_month,due_on,billed_minor,benefit_minor,source)
 values(uid,p_card_id,p_month,p_due_on,billed,benefit,btrim(p_source)) returning id into result;
 return result;
end;
$$;

create function public.allocate_card_statement_payment(p_statement_id uuid,p_payment_id uuid,p_amount_minor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 uid uuid := auth.uid();
 statement_row public.card_statements%rowtype;
 payment record;
 allocation bigint;
 existing bigint;
 paid numeric;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_amount_minor is null or p_amount_minor !~ '^(0|[1-9][0-9]{0,18})$' then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 allocation := p_amount_minor::bigint;
 select * into statement_row from public.card_statements where user_id=uid and id=p_statement_id for update;
 if not found then raise exception 'STATEMENT_NOT_FOUND' using errcode='P0002'; end if;
 select t.amount_minor,m.debit_account_id into payment from public.transactions t
 join public.account_movements m on m.user_id=t.user_id and m.transaction_id=t.id
 where t.user_id=uid and t.id=p_payment_id and t.kind='card_payment' for update of t;
 if not found or payment.debit_account_id<>statement_row.card_id then raise exception 'STATEMENT_PAYMENT_NOT_FOUND' using errcode='P0002'; end if;
 select a.amount_minor into existing from public.card_statement_payments a
 where a.user_id=uid and a.statement_id=p_statement_id and a.payment_id=p_payment_id;
 select coalesce(sum(a.amount_minor),0) into paid from public.card_statement_payments a
 where a.user_id=uid and a.statement_id=p_statement_id and a.payment_id<>p_payment_id;
 if paid+allocation>statement_row.billed_minor or allocation+(
  select coalesce(sum(a.amount_minor),0) from public.card_statement_payments a
  where a.user_id=uid and a.payment_id=p_payment_id and a.statement_id<>p_statement_id
 )>payment.amount_minor then raise exception 'STATEMENT_ALLOCATION_EXCEEDS_TOTAL' using errcode='22023'; end if;
 if allocation is distinct from coalesce(existing,0) then
  if allocation=0 then
   delete from public.card_statement_payments where user_id=uid and statement_id=p_statement_id and payment_id=p_payment_id;
  else
   insert into public.card_statement_payments(user_id,statement_id,payment_id,amount_minor)
   values(uid,p_statement_id,p_payment_id,allocation)
   on conflict(user_id,statement_id,payment_id) do update set amount_minor=excluded.amount_minor;
  end if;
  insert into public.audit_logs(user_id,entity_type,entity_id,action,details)
  values(uid,'card_statement',p_statement_id,'payment_allocation',jsonb_build_object(
   'payment_id',p_payment_id,'previous_minor',coalesce(existing,0)::text,'amount_minor',allocation::text));
 end if;
 return jsonb_build_object('paid_minor',(paid+allocation)::text,'remaining_minor',(statement_row.billed_minor-paid-allocation)::text);
end;
$$;

create function public.list_card_statements(p_month date) returns jsonb
language sql stable set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',s.id,'card_id',s.card_id,'card',a.name,'due_on',s.due_on,'billed_minor',s.billed_minor::text,
  'benefit_minor',s.benefit_minor::text,'paid_minor',p.paid::text,
  'remaining_minor',(s.billed_minor-p.paid)::text,'source',s.source,'payments',p.payments
 ) order by s.due_on,s.id),'[]'::jsonb)
 from public.card_statements s join public.financial_accounts a on a.user_id=s.user_id and a.id=s.card_id
 cross join lateral (
  select coalesce(sum(x.amount_minor),0) as paid,
   coalesce(jsonb_agg(jsonb_build_object('payment_id',x.payment_id,'amount_minor',x.amount_minor::text) order by x.payment_id),'[]'::jsonb) as payments
  from public.card_statement_payments x where x.user_id=s.user_id and x.statement_id=s.id
 ) p where s.user_id=(select auth.uid()) and s.statement_month=p_month
$$;
revoke all on function public.register_card_statement(uuid,date,date,text,text,text),
 public.allocate_card_statement_payment(uuid,uuid,text),public.list_card_statements(date) from public,anon;
grant execute on function public.register_card_statement(uuid,date,date,text,text,text),
 public.allocate_card_statement_payment(uuid,uuid,text),public.list_card_statements(date) to authenticated;
