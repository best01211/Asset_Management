create table public.card_benefit_terms (
 user_id uuid not null,
 card_id uuid not null,
 version integer not null check(version>0),
 request_id uuid not null,
 effective_from date not null check(effective_from between date '1900-01-01' and date '9998-12-31'),
 effective_until date check(effective_until between effective_from and date '9998-12-31'),
 source text not null check(length(source) between 1 and 200),
 category_id uuid,
 rate_bps integer not null check(rate_bps between 1 and 10000),
 prior_spend_minor bigint not null check(prior_spend_minor>=0),
 monthly_cap_minor bigint check(monthly_cap_minor>=0),
 created_at timestamptz not null default now(),
 primary key(user_id,card_id,version),
 unique(user_id,request_id),
 foreign key(user_id,card_id) references public.financial_accounts(user_id,id),
 foreign key(user_id,category_id) references public.categories(user_id,id)
);

create index card_benefit_terms_effective_date
 on public.card_benefit_terms(user_id,card_id,effective_from desc,version desc);
alter table public.card_benefit_terms enable row level security;
revoke all on public.card_benefit_terms from public,anon,authenticated;
grant select on public.card_benefit_terms to authenticated;
create policy card_benefit_terms_owner on public.card_benefit_terms for select to authenticated
 using (user_id=(select auth.uid()));

create function public.register_card_benefit_terms(
 p_card_id uuid,p_request_id uuid,p_effective_from date,p_effective_until date,p_source text,
 p_category_id uuid,p_rate_bps integer,p_prior_spend_minor text,p_monthly_cap_minor text
) returns integer language plpgsql security definer set search_path = '' as $$
declare
 uid uuid := auth.uid();
 prior public.card_benefit_terms%rowtype;
 next_version integer;
 source_text text := btrim(p_source);
 threshold bigint;
 cap bigint;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_card_id is null or p_request_id is null or p_effective_from is null
  or p_effective_from not between date '1900-01-01' and date '9998-12-31'
  or (p_effective_until is not null and p_effective_until not between p_effective_from and date '9998-12-31')
  or source_text is null or length(source_text) not between 1 and 200
  or p_rate_bps is null or p_rate_bps not between 1 and 10000
  or p_prior_spend_minor is null or p_prior_spend_minor !~ '^(0|[1-9][0-9]{0,18})$'
  or (p_monthly_cap_minor is not null and p_monthly_cap_minor !~ '^(0|[1-9][0-9]{0,18})$') then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;
 threshold := p_prior_spend_minor::bigint;
 cap := p_monthly_cap_minor::bigint;

 perform pg_advisory_xact_lock(hashtextextended('benefit:'||uid::text||':'||p_request_id::text,0));
 select * into prior from public.card_benefit_terms t where t.user_id=uid and t.request_id=p_request_id;
 if found then
  if (prior.card_id,prior.effective_from,prior.effective_until,prior.source,prior.category_id,
      prior.rate_bps,prior.prior_spend_minor,prior.monthly_cap_minor)
   is distinct from (p_card_id,p_effective_from,p_effective_until,source_text,p_category_id,p_rate_bps,threshold,cap) then
   raise exception 'CARD_BENEFIT_REQUEST_CONFLICT' using errcode='23505';
  end if;
  return prior.version;
 end if;
 perform 1 from public.financial_accounts a where a.user_id=uid and a.id=p_card_id
  and a.kind='liability' and a.currency='KRW' and a.active for update;
 if not found then raise exception 'BENEFIT_CARD_NOT_FOUND' using errcode='P0002'; end if;
 if p_category_id is not null and not exists (
  select 1 from public.categories c join public.financial_accounts a
    on a.user_id=c.user_id and a.id=c.expense_account_id and a.kind='expense' and a.currency='KRW'
  where c.user_id=uid and c.id=p_category_id
 ) then raise exception 'BENEFIT_CATEGORY_NOT_FOUND' using errcode='P0002'; end if;

 select coalesce(max(t.version),0)+1 into next_version
 from public.card_benefit_terms t where t.user_id=uid and t.card_id=p_card_id;
 insert into public.card_benefit_terms(user_id,card_id,version,request_id,effective_from,effective_until,source,
  category_id,rate_bps,prior_spend_minor,monthly_cap_minor)
 values(uid,p_card_id,next_version,p_request_id,p_effective_from,p_effective_until,source_text,
  p_category_id,p_rate_bps,threshold,cap);
 return next_version;
end;
$$;

create function public.estimate_card_benefit(
 p_card_id uuid,p_purchase_date date,p_category_id uuid,p_eligible_amount_minor text,
 p_prior_eligible_minor text,p_used_benefit_minor text
) returns jsonb language plpgsql stable set search_path = '' as $$
declare
 uid uuid := auth.uid();
 terms public.card_benefit_terms%rowtype;
 eligibility text := 'eligible';
 available bigint;
 predicted bigint := 0;
 eligible_amount bigint;
 prior_eligible bigint;
 used_benefit bigint;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_card_id is null or p_purchase_date is null or p_purchase_date not between date '1900-01-01' and date '9998-12-31'
  or p_eligible_amount_minor is null or p_eligible_amount_minor !~ '^(0|[1-9][0-9]{0,18})$'
  or p_prior_eligible_minor is null or p_prior_eligible_minor !~ '^(0|[1-9][0-9]{0,18})$'
  or p_used_benefit_minor is null or p_used_benefit_minor !~ '^(0|[1-9][0-9]{0,18})$' then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;
 eligible_amount := p_eligible_amount_minor::bigint;
 prior_eligible := p_prior_eligible_minor::bigint;
 used_benefit := p_used_benefit_minor::bigint;
 if not exists (select 1 from public.financial_accounts a where a.user_id=uid and a.id=p_card_id
  and a.kind='liability' and a.currency='KRW' and a.active)
 then raise exception 'BENEFIT_CARD_NOT_FOUND' using errcode='P0002'; end if;
 if p_category_id is not null and not exists (
  select 1 from public.categories c where c.user_id=uid and c.id=p_category_id
 ) then raise exception 'BENEFIT_CATEGORY_NOT_FOUND' using errcode='P0002'; end if;

 select * into terms from public.card_benefit_terms t where t.user_id=uid and t.card_id=p_card_id
  and t.effective_from<=p_purchase_date order by t.effective_from desc,t.version desc limit 1;
 if not found or p_purchase_date>terms.effective_until then
  raise exception 'BENEFIT_TERMS_NOT_FOUND' using errcode='P0002';
 end if;
 if terms.monthly_cap_minor is not null then available := greatest(terms.monthly_cap_minor-used_benefit,0); end if;
 if prior_eligible<terms.prior_spend_minor then
  eligibility := 'prior_spend';
 elsif terms.category_id is not null and terms.category_id is distinct from p_category_id then
  eligibility := 'category';
 elsif available=0 then
  eligibility := 'cap';
 else
  predicted := floor(eligible_amount::numeric*terms.rate_bps/10000)::bigint;
  if available is not null then predicted := least(predicted,available); end if;
 end if;
 return jsonb_build_object(
  'estimated_minor',predicted::text,'remaining_cap_minor',available::text,'eligibility',eligibility,
  'terms_version',terms.version,'effective_from',terms.effective_from,'effective_until',terms.effective_until,
  'source',terms.source,'rate_bps',terms.rate_bps);
end;
$$;

revoke all on function public.register_card_benefit_terms(uuid,uuid,date,date,text,uuid,integer,text,text),
 public.estimate_card_benefit(uuid,date,uuid,text,text,text) from public,anon;
grant execute on function public.register_card_benefit_terms(uuid,uuid,date,date,text,uuid,integer,text,text),
 public.estimate_card_benefit(uuid,date,uuid,text,text,text) to authenticated;
