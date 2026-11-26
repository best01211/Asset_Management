create table public.recurring_services (
 user_id uuid not null,
 id uuid not null default gen_random_uuid(),
 created_at timestamptz not null default now(),
 primary key(user_id,id)
);

create table public.recurring_service_revisions (
 user_id uuid not null,
 service_id uuid not null,
 version integer not null check(version>0),
 effective_on date not null,
 name text not null check(length(name) between 1 and 100),
 amount_minor bigint not null check(amount_minor>0),
 currency text not null check(currency~'^[A-Z]{3}$'),
 cycle_unit text not null check(cycle_unit in ('day','month')),
 cycle_count integer not null check(cycle_count between 1 and 366 and (cycle_unit='day' or cycle_count<=12)),
 anchor_on date not null,
 end_on date,
 category_id uuid,
 account_id uuid,
 status text not null check(status in ('active','paused','cancelled')),
 auto_match boolean not null,
 aliases text[] not null check(cardinality(aliases)<=12),
 web_enabled boolean not null,
 push_enabled boolean not null,
 advance_days integer not null check(advance_days in (0,1,3,7)),
 unmatched_alert boolean not null,
 note text not null check(length(note)<=1000),
 created_at timestamptz not null default now(),
 primary key(user_id,service_id,version),
 foreign key(user_id,service_id) references public.recurring_services(user_id,id),
 foreign key(user_id,category_id) references public.categories(user_id,id),
 foreign key(user_id,account_id) references public.financial_accounts(user_id,id),
 check(end_on is null or end_on>=anchor_on)
);
create index recurring_revisions_effective on public.recurring_service_revisions(user_id,service_id,effective_on,version desc);

create table public.recurring_occurrences (
 user_id uuid not null,
 id uuid not null default gen_random_uuid(),
 service_id uuid not null,
 revision integer not null,
 due_on date not null,
 amount_minor bigint not null check(amount_minor>0),
 currency text not null check(currency~'^[A-Z]{3}$'),
 excluded boolean not null default false,
 skipped boolean not null default false,
 match_issue text check(match_issue in ('ambiguous','different_amount','account_missing')),
 primary key(user_id,id),
 unique(user_id,service_id,due_on),
 foreign key(user_id,service_id,revision) references public.recurring_service_revisions(user_id,service_id,version)
);
create index recurring_occurrence_date on public.recurring_occurrences(user_id,due_on);

create table public.recurring_transaction_links (
 user_id uuid not null,
 occurrence_id uuid not null,
 transaction_id uuid not null,
 method text not null check(method in ('automatic','manual')),
 reason text not null,
 final_payment boolean not null,
 matched_at timestamptz not null default now(),
 primary key(user_id,transaction_id),
 foreign key(user_id,occurrence_id) references public.recurring_occurrences(user_id,id),
 foreign key(user_id,transaction_id) references public.transactions(user_id,id)
);
create index recurring_link_occurrence on public.recurring_transaction_links(user_id,occurrence_id);

create table public.recurring_web_alerts (
 user_id uuid not null,
 id uuid not null default gen_random_uuid(),
 occurrence_id uuid not null,
 kind text not null check(kind in ('advance','overdue','conflict')),
 notify_on date not null,
 read_at timestamptz,
 primary key(user_id,id),
 unique(user_id,occurrence_id,kind,notify_on),
 foreign key(user_id,occurrence_id) references public.recurring_occurrences(user_id,id)
);
do $$
declare relation text;
begin
 foreach relation in array array['recurring_services','recurring_service_revisions','recurring_occurrences','recurring_transaction_links','recurring_web_alerts'] loop
  execute format('alter table public.%I enable row level security',relation);
  execute format('revoke all on public.%I from public,anon,authenticated',relation);
  execute format('grant select on public.%I to authenticated',relation);
  execute format('create policy recurring_owner_read on public.%I for select to authenticated using(user_id=(select auth.uid()))',relation);
 end loop;
end;
$$;

create function private.recurring_today() returns date language sql stable set search_path='' as $$
 select (now() at time zone 'Asia/Seoul')::date
$$;
create function private.recurring_lock(p_user uuid) returns void language sql set search_path='' as $$
 select pg_advisory_xact_lock(hashtextextended('recurring:' || p_user::text,0))
$$;
create function private.recurring_name(p_value text) returns text language sql immutable set search_path='' as $$
 select lower(regexp_replace(trim(p_value),'[[:space:]]+',' ','g'))
$$;

-- A monthly anchor on the 29th–31st falls on the last valid day of shorter months.
create function private.recurring_schedule(p_user uuid,p_from date,p_to date)
returns table(service_id uuid,revision integer,due_on date,amount_minor bigint,currency text)
language sql stable set search_path='' as $$
 with available as (
  select distinct on (r.service_id,r.effective_on) r.*
  from public.recurring_service_revisions r where r.user_id=p_user and r.effective_on<=p_to
  order by r.service_id,r.effective_on,r.version desc
 ), windows as (
  select a.*,lead(a.effective_on) over (partition by a.service_id order by a.effective_on) as next_effective
  from available a
 )
 select w.service_id,w.version,d.day::date,w.amount_minor,w.currency
 from windows w cross join lateral generate_series(
  greatest(p_from,w.effective_on,w.anchor_on)::timestamp,
  least(p_to,w.next_effective-1,w.end_on)::timestamp,interval '1 day'
 ) d(day)
 where w.status='active' and case when w.cycle_unit='day' then (d.day::date-w.anchor_on)%w.cycle_count=0
 else (extract(year from d.day)::int*12+extract(month from d.day)::int
       -extract(year from w.anchor_on)::int*12-extract(month from w.anchor_on)::int)%w.cycle_count=0
  and extract(day from d.day)=least(extract(day from w.anchor_on),
    extract(day from (date_trunc('month',d.day)+interval '1 month -1 day')))
 end
$$;

create function private.materialize_recurring(p_user uuid,p_from date,p_to date) returns void
language sql set search_path='' as $$
 with desired as materialized (
  select * from private.recurring_schedule(p_user,p_from,p_to)
 ), reopened as (
  update public.recurring_occurrences o set excluded=false
  from desired d where o.user_id=p_user and o.service_id=d.service_id and o.due_on=d.due_on
   and o.excluded and not o.skipped
   and exists(select 1 from public.recurring_transaction_links l where l.user_id=p_user and l.occurrence_id=o.id)
 ), saved as (
  insert into public.recurring_occurrences as current(user_id,service_id,revision,due_on,amount_minor,currency)
  select p_user,service_id,revision,due_on,amount_minor,currency from desired
  on conflict(user_id,service_id,due_on) do update set revision=excluded.revision,amount_minor=excluded.amount_minor,
   currency=excluded.currency,excluded=false,match_issue=case when current.revision=excluded.revision then current.match_issue end
  where not current.skipped and (current.excluded or current.revision<>excluded.revision)
   and not exists(select 1 from public.recurring_transaction_links l where l.user_id=current.user_id and l.occurrence_id=current.id)
 )
 update public.recurring_occurrences o set excluded=true,match_issue=null
 where o.user_id=p_user and o.due_on between p_from and p_to and not o.excluded and not o.skipped
  and not exists(select 1 from desired d where d.service_id=o.service_id and d.due_on=o.due_on)
  and not exists(
   select 1 from public.recurring_transaction_links l join public.transactions t
    on t.user_id=l.user_id and t.id=l.transaction_id
   where l.user_id=p_user and l.occurrence_id=o.id and not exists(
    select 1 from public.purchase_reversals r where r.user_id=l.user_id and r.original_purchase_id=l.transaction_id
   )
   having bool_or(l.final_payment) or sum(t.amount_minor)>=o.amount_minor
  )
$$;

create function private.recurring_state(p_user uuid,p_from date,p_to date)
returns table(id uuid,service_id uuid,revision integer,due_on date,amount_minor bigint,currency text,
 actual_minor numeric,remaining_minor numeric,status text,match_issue text,links jsonb)
language sql stable set search_path='' as $$
 with accounted as (
  select o.*,coalesce(confirmed.total,0) as actual,coalesce(confirmed.final,false) as final,
   coalesce(confirmed.reversed,false) as reversed,
   coalesce(confirmed.links,'[]'::jsonb) as links
  from public.recurring_occurrences o left join lateral (
   select sum(x.amount_minor) filter(where not x.reversed) as total,
    bool_or(x.final_payment) filter(where not x.reversed) as final,bool_or(x.reversed) as reversed,
    jsonb_agg(jsonb_build_object('id',x.id,'name',x.merchant,'amount_minor',x.amount_minor::text,
      'occurred_at',x.occurred_at,'method',x.method,'reason',x.reason,'matched_at',x.matched_at,'reversed',x.reversed)
      order by x.occurred_at,x.id) as links
   from (
    select t.id,t.merchant,t.amount_minor,t.occurred_at,l.method,l.reason,l.final_payment,l.matched_at,
     exists(select 1 from public.purchase_reversals r where r.user_id=t.user_id and r.original_purchase_id=t.id) as reversed
    from public.recurring_transaction_links l join public.transactions t
     on t.user_id=l.user_id and t.id=l.transaction_id
    where l.user_id=o.user_id and l.occurrence_id=o.id
   ) x
  ) confirmed on true
  where o.user_id=p_user and o.due_on between p_from and p_to
 )
 select a.id,a.service_id,a.revision,a.due_on,a.amount_minor,a.currency,a.actual,
  case when a.skipped or a.excluded or a.final then 0 else greatest(a.amount_minor-a.actual,0) end,
  case when a.skipped or a.excluded then 'skipped'
   when a.final or a.actual>=a.amount_minor then 'completed'
   when a.match_issue is not null or a.reversed or a.actual>0 or a.due_on<private.recurring_today() then 'needs_review'
   else 'scheduled' end,a.match_issue,a.links
 from accounted a
$$;
create function private.save_recurring_service(p_id uuid,p_expected integer,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 uid uuid:=auth.uid();
 draft public.recurring_service_revisions%rowtype;
 prior public.recurring_service_revisions%rowtype;
 current_day date:=private.recurring_today();
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_id is null or p_expected is null or p_expected not between 0 and 2147483646
  or jsonb_typeof(p_input) is distinct from 'object' then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 draft:=jsonb_populate_record(null::public.recurring_service_revisions,p_input);
 draft.name:=trim(draft.name);
 draft.note:=coalesce(draft.note,'');
 draft.aliases:=coalesce(draft.aliases,array[]::text[]);
 if draft.name is null or length(draft.name) not between 1 and 100 or draft.amount_minor is null or draft.amount_minor<=0
  or draft.currency is null or draft.currency!~'^[A-Z]{3}$' or draft.cycle_unit is null or draft.cycle_unit not in ('day','month')
  or draft.cycle_count is null or draft.cycle_count not between 1 and 366 or (draft.cycle_unit='month' and draft.cycle_count>12)
  or draft.anchor_on is null or draft.anchor_on not between date '1900-01-01' and date '9997-12-31'
  or (draft.end_on is not null and draft.end_on not between draft.anchor_on and date '9997-12-31')
  or draft.status is null or draft.status not in ('active','paused','cancelled') or length(draft.note)>1000
  or cardinality(draft.aliases)>12 or coalesce(array_ndims(draft.aliases),1)<>1
  or exists(select 1 from unnest(draft.aliases) n where n is null or length(trim(n)) not between 1 and 100)
  or draft.auto_match is null or draft.web_enabled is null or draft.push_enabled is null
  or draft.unmatched_alert is null or draft.advance_days is null or draft.advance_days not in (0,1,3,7)
  then raise exception 'INVALID_INPUT' using errcode='22023'; end if;

 perform private.recurring_lock(uid);
 select * into prior from public.recurring_service_revisions where user_id=uid and service_id=p_id
 order by version desc limit 1;
 draft.effective_on:=coalesce(draft.effective_on,case when p_expected=0 then least(draft.anchor_on,current_day) else current_day end);

 if prior.version is not null and p_expected<=prior.version and
  row(draft.effective_on,draft.name,draft.amount_minor,draft.currency,draft.cycle_unit,draft.cycle_count,
      draft.anchor_on,draft.end_on,draft.category_id,draft.account_id,draft.status,draft.auto_match,draft.aliases,
      draft.web_enabled,draft.push_enabled,draft.advance_days,draft.unmatched_alert,draft.note)
  is not distinct from
  row(prior.effective_on,prior.name,prior.amount_minor,prior.currency,prior.cycle_unit,prior.cycle_count,
      prior.anchor_on,prior.end_on,prior.category_id,prior.account_id,prior.status,prior.auto_match,prior.aliases,
      prior.web_enabled,prior.push_enabled,prior.advance_days,prior.unmatched_alert,prior.note)
  then return jsonb_build_object('id',p_id,'version',prior.version); end if;

 if coalesce(prior.version,0)<>p_expected then raise exception 'STALE_RECURRING_SERVICE' using errcode='23505'; end if;
 if draft.effective_on not between date '1900-01-01' and date '9997-12-31'
  or (prior.version is not null and draft.effective_on<greatest(current_day,prior.effective_on))
  then raise exception 'INVALID_EFFECTIVE_DATE' using errcode='22023'; end if;
 if draft.category_id is not null and draft.category_id is distinct from prior.category_id and not exists(
  select 1 from public.categories where user_id=uid and id=draft.category_id and transaction_type='expense' and is_active
 ) then raise exception 'CATEGORY_UNAVAILABLE' using errcode='22023'; end if;
 if draft.account_id is not null and not exists(select 1 from public.financial_accounts where user_id=uid
  and id=draft.account_id and kind in ('asset','liability') and currency=draft.currency
  and (active or id=prior.account_id)) then raise exception 'PAYMENT_ACCOUNT_UNAVAILABLE' using errcode='22023'; end if;
 if prior.version is null then insert into public.recurring_services(user_id,id) values(uid,p_id); end if;

 insert into public.recurring_service_revisions(user_id,service_id,version,effective_on,name,amount_minor,currency,
  cycle_unit,cycle_count,anchor_on,end_on,category_id,account_id,status,auto_match,aliases,web_enabled,push_enabled,
  advance_days,unmatched_alert,note)
 values(uid,p_id,p_expected+1,draft.effective_on,draft.name,draft.amount_minor,draft.currency,draft.cycle_unit,
  draft.cycle_count,draft.anchor_on,draft.end_on,draft.category_id,draft.account_id,draft.status,draft.auto_match,
  draft.aliases,draft.web_enabled,draft.push_enabled,draft.advance_days,draft.unmatched_alert,draft.note);
 return jsonb_build_object('id',p_id,'version',p_expected+1);
end;
$$;

create function private.recurring_match_purchase() returns trigger
language plpgsql security definer set search_path='' as $$
declare
 uid uuid:=new.user_id;
 purchase_day date:=(new.occurred_at at time zone 'Asia/Seoul')::date;
 candidates uuid[];
 matched uuid;
 issue text;
begin
 if not exists(select 1 from public.recurring_services where user_id=uid) then return new; end if;
 perform private.recurring_lock(uid);
 perform private.materialize_recurring(uid,purchase_day-2,purchase_day+2);
 select array_agg(o.id) into candidates
 from public.recurring_occurrences o
 join public.recurring_service_revisions r on r.user_id=o.user_id and r.service_id=o.service_id and r.version=o.revision
 where o.user_id=uid and o.due_on between purchase_day-2 and purchase_day+2 and not o.excluded and not o.skipped
  and o.currency=new.currency and r.auto_match and (r.account_id is null or r.account_id=new.payment_account_id)
  and (private.recurring_name(r.name)=private.recurring_name(new.merchant) or exists(
   select 1 from unnest(r.aliases) n where private.recurring_name(n)=private.recurring_name(new.merchant)
  ))
  and not exists(select 1 from public.recurring_transaction_links l where l.user_id=uid and l.occurrence_id=o.id);
 if coalesce(cardinality(candidates),0)=0 then return new; end if;
 if cardinality(candidates)=1 then
  select case when r.account_id is null then 'account_missing'
    when o.amount_minor<>new.amount_minor then 'different_amount' end into issue
  from public.recurring_occurrences o join public.recurring_service_revisions r
   on r.user_id=o.user_id and r.service_id=o.service_id and r.version=o.revision
  where o.user_id=uid and o.id=candidates[1];
  if issue is null then matched:=candidates[1]; end if;
 else issue:='ambiguous'; end if;

 if matched is not null then
  insert into public.recurring_transaction_links(user_id,occurrence_id,transaction_id,method,reason,final_payment)
  values(uid,matched,new.confirmed_transaction_id,'automatic','exact_merchant_account_amount_within_two_days',true)
  on conflict(user_id,transaction_id) do nothing;
  if found then
   update public.recurring_occurrences set match_issue=null where user_id=uid and id=matched;
   insert into public.audit_logs(user_id,entity_type,entity_id,action,details)
   values(uid,'recurring_occurrence',matched,'recurring_auto_linked',jsonb_build_object('transaction_id',new.confirmed_transaction_id,
    'reason','exact_merchant_account_amount_within_two_days'));
  end if;
 else
  update public.recurring_occurrences set match_issue=issue where user_id=uid and id=any(candidates);
  insert into public.audit_logs(user_id,entity_type,entity_id,action,details)
   select uid,'recurring_occurrence',candidate,'recurring_match_review',
      jsonb_build_object('transaction_id',new.confirmed_transaction_id,'reason',issue)
   from unnest(candidates) candidate;
 end if;
 return new;
end;
$$;
create trigger recurring_after_purchase_approval after update of status on public.pending_transactions for each row
 when(old.status is distinct from new.status and new.status='confirmed' and new.confirmed_transaction_id is not null)
 execute function private.recurring_match_purchase();

create function private.change_recurring_occurrence(p_id uuid,p_action text,p_transaction uuid,p_final boolean) returns void
language plpgsql security definer set search_path='' as $$
declare
 uid uuid:=auth.uid();
 item public.recurring_occurrences%rowtype;
 purchase public.transactions%rowtype;
 existing public.recurring_transaction_links%rowtype;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_action is null or p_action not in ('link','unlink','skip','restore') then
  raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 perform private.recurring_lock(uid);
 select * into item from public.recurring_occurrences where user_id=uid and id=p_id;
 if not found then raise exception 'OCCURRENCE_NOT_FOUND' using errcode='P0002'; end if;

 if p_action='skip' then
  if exists(select 1 from private.recurring_state(uid,item.due_on,item.due_on) s where s.id=p_id and s.status='completed')
   then raise exception 'OCCURRENCE_COMPLETED' using errcode='23505'; end if;
  update public.recurring_occurrences set skipped=true,match_issue=null where user_id=uid and id=p_id and not skipped;
 elsif p_action='restore' then
  update public.recurring_occurrences set skipped=false where user_id=uid and id=p_id and skipped;
  if not found then return; end if;
  perform private.materialize_recurring(uid,item.due_on,item.due_on);
 elsif p_action='unlink' then
  delete from public.recurring_transaction_links where user_id=uid and occurrence_id=p_id and transaction_id=p_transaction;
 else
  if p_transaction is null or p_final is null then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
  select * into existing from public.recurring_transaction_links where user_id=uid and transaction_id=p_transaction;
  if found then
   if existing.occurrence_id=p_id then return; end if;
   raise exception 'TRANSACTION_ALREADY_LINKED' using errcode='23505';
  end if;
  if item.skipped or item.excluded or exists(
   select 1 from private.recurring_state(uid,item.due_on,item.due_on) s where s.id=p_id and s.status='completed'
  ) then raise exception 'OCCURRENCE_UNAVAILABLE' using errcode='23505'; end if;
  select t.* into purchase from public.transactions t join public.pending_transactions p
   on p.user_id=t.user_id and p.id=t.source_pending_id and p.status='confirmed' and p.confirmed_transaction_id=t.id
   where t.user_id=uid and t.id=p_transaction and t.currency=item.currency
    and t.kind in ('purchase_cash','purchase_debit','purchase_credit')
    and not exists(select 1 from public.purchase_reversals r where r.user_id=uid and r.original_purchase_id=t.id);
  if not found then raise exception 'CONFIRMED_PURCHASE_NOT_FOUND' using errcode='P0002'; end if;
  insert into public.recurring_transaction_links(user_id,occurrence_id,transaction_id,method,reason,final_payment)
  values(uid,p_id,purchase.id,'manual','user_confirmed',p_final);
  update public.recurring_occurrences set match_issue=null where user_id=uid and id=p_id;
 end if;
 if found or p_action='restore' then
  insert into public.audit_logs(user_id,entity_type,entity_id,action,details)
  values(uid,'recurring_occurrence',p_id,'recurring_' || p_action,
    jsonb_build_object('transaction_id',p_transaction,'final_payment',p_final));
 end if;
end;
$$;

create function private.recurring_active_alerts(p_user uuid)
returns table(occurrence_id uuid,kind text,notify_on date)
language sql stable set search_path='' as $$
 select s.id,n.kind,n.notify_on from private.recurring_state(p_user,private.recurring_today()-31,private.recurring_today()+7) s
 join lateral (
  select r.* from public.recurring_service_revisions r where r.user_id=p_user and r.service_id=s.service_id
   and r.effective_on<=private.recurring_today() order by r.version desc limit 1
 ) setting on setting.web_enabled and setting.status='active'
 cross join lateral (values
  ('advance',s.due_on-setting.advance_days,private.recurring_today() between s.due_on-setting.advance_days and s.due_on),
  ('overdue',s.due_on+1,setting.unmatched_alert and s.due_on<private.recurring_today()),
  ('conflict',s.due_on,s.match_issue is not null)
 ) n(kind,notify_on,show)
 where s.status in ('scheduled','needs_review') and n.show
$$;

create function private.read_recurring_month(p_month date,p_home boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 uid uuid:=auth.uid();
 current_day date:=private.recurring_today();
 last_day date;
 items jsonb;
 services jsonb;
 alerts jsonb;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_month is null or p_month not between date '1900-01-01' and date '9997-12-01'
  or extract(day from p_month)<>1 or p_home is null then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 last_day:=(p_month+interval '1 month -1 day')::date;
 perform private.recurring_lock(uid);
 perform private.materialize_recurring(uid,p_month,last_day);
 perform private.materialize_recurring(uid,current_day-31,current_day+7);
 insert into public.recurring_web_alerts(user_id,occurrence_id,kind,notify_on)
 select uid,a.occurrence_id,a.kind,a.notify_on from private.recurring_active_alerts(uid) a
 on conflict(user_id,occurrence_id,kind,notify_on) do nothing;

 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'service_id',s.service_id,'due_on',s.due_on,
  'name',r.name,'category_id',r.category_id,'account_id',r.account_id,'amount_minor',s.amount_minor::text,
  'actual_minor',s.actual_minor::text,'remaining_minor',s.remaining_minor::text,'currency',s.currency,
  'status',s.status,'match_issue',s.match_issue,'links',s.links,'skipped',o.skipped
 ) order by s.due_on,s.id),'[]'::jsonb) into items
 from private.recurring_state(uid,p_month,last_day) s
 join public.recurring_service_revisions r on r.user_id=uid and r.service_id=s.service_id and r.version=s.revision
 join public.recurring_occurrences o on o.user_id=uid and o.id=s.id;

 select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'occurrence_id',o.id,'service_id',o.service_id,'name',r.name,
  'kind',a.kind,'notify_on',a.notify_on,'due_on',o.due_on,'read_at',a.read_at) order by a.notify_on,a.id),'[]'::jsonb)
 into alerts from private.recurring_active_alerts(uid) related
 join public.recurring_web_alerts a on a.user_id=uid and a.occurrence_id=related.occurrence_id
  and a.kind=related.kind and a.notify_on=related.notify_on
 join public.recurring_occurrences o on o.user_id=uid and o.id=a.occurrence_id
 join public.recurring_service_revisions r on r.user_id=uid and r.service_id=o.service_id and r.version=o.revision;

 if not p_home then
  with upcoming as (
   select s.service_id,min(s.due_on) as due_on
   from private.recurring_schedule(uid,current_day,current_day+366) s
   left join private.recurring_state(uid,current_day,current_day+366) saved
    on saved.service_id=s.service_id and saved.due_on=s.due_on
   where saved.status is null or saved.status in ('scheduled','needs_review')
   group by s.service_id
  )
  select coalesce(jsonb_agg((to_jsonb(latest)-'user_id'-'service_id')||jsonb_build_object(
   'id',service.id,'amount_minor',latest.amount_minor::text,'current_status',coalesce(applied.status,latest.status),
   'next_due',coalesce(u.due_on,case when latest.status='active' and latest.anchor_on>current_day+366
     and latest.anchor_on>=latest.effective_on then latest.anchor_on end),
   'category_name',c.name,'account_name',a.name,'month_status',month_item.item->>'status'
  ) order by coalesce(applied.status,latest.status)<>'active',u.due_on,latest.name,service.id),'[]'::jsonb)
  into services from public.recurring_services service
  join lateral (select r.* from public.recurring_service_revisions r where r.user_id=uid and r.service_id=service.id
   order by r.version desc limit 1) latest on true
  left join lateral (select r.status from public.recurring_service_revisions r where r.user_id=uid and r.service_id=service.id
   and r.effective_on<=current_day order by r.version desc limit 1) applied on true
  left join upcoming u on u.service_id=service.id
  left join public.categories c on c.user_id=uid and c.id=latest.category_id
  left join public.financial_accounts a on a.user_id=uid and a.id=latest.account_id
  left join lateral (select x.item from jsonb_array_elements(items) x(item) where x.item->>'service_id'=service.id::text
   order by case x.item->>'status' when 'needs_review' then 0 when 'scheduled' then 1 when 'completed' then 2 else 3 end,
    x.item->>'due_on' limit 1) month_item on true
  where service.user_id=uid;
 end if;

 return jsonb_build_object('month',to_char(p_month,'YYYY-MM'),'today',current_day,'services',coalesce(services,'[]'::jsonb),
  'occurrences',items,'alerts',alerts,
  'ledger_summary',case when p_home then public.summarize_confirmed_purchases(p_month) end);
end;
$$;

create function private.read_recurring_service_history(p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'revisions',coalesce((select jsonb_agg(to_jsonb(v) order by v.version desc) from (
   select version,effective_on,name,status,anchor_on,end_on,cycle_unit,cycle_count,currency,amount_minor::text,
    web_enabled,push_enabled,advance_days,unmatched_alert,created_at
   from public.recurring_service_revisions r where r.user_id=s.user_id and r.service_id=s.id order by version desc limit 30
  ) v),'[]'::jsonb),
  'payments',coalesce((select jsonb_agg(to_jsonb(v) order by v.due_on desc,v.id) from (
   select o.id,o.due_on,state.status,state.currency,state.actual_minor::text,state.links
   from public.recurring_occurrences o join lateral private.recurring_state(s.user_id,o.due_on,o.due_on) state on state.id=o.id
   where o.user_id=s.user_id and o.service_id=s.id and jsonb_array_length(state.links)>0
   order by o.due_on desc,o.id limit 12
  ) v),'[]'::jsonb)
 )
 from public.recurring_services s where s.user_id=(select auth.uid()) and s.id=p_id
$$;

create function private.read_recurring_candidates(p_id uuid,p_transaction uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(c) order by c.occurred_at desc,c.id),'[]'::jsonb)
 from public.recurring_occurrences o
 cross join lateral (
  select t.id,t.merchant as name,t.amount_minor::text,t.currency,t.occurred_at,a.name as account_name
  from public.transactions t join public.pending_transactions p
   on p.user_id=t.user_id and p.id=t.source_pending_id and p.status='confirmed' and p.confirmed_transaction_id=t.id
  join public.financial_accounts a on a.user_id=p.user_id and a.id=p.payment_account_id
  where t.user_id=o.user_id and t.currency=o.currency and t.kind in ('purchase_cash','purchase_debit','purchase_credit')
   and ((p_transaction is not null and t.id=p_transaction) or (p_transaction is null
    and t.occurred_at >= (o.due_on-31)::timestamp at time zone 'Asia/Seoul'
    and t.occurred_at < (o.due_on+32)::timestamp at time zone 'Asia/Seoul'))
   and not exists(select 1 from public.recurring_transaction_links l where l.user_id=t.user_id and l.transaction_id=t.id)
   and not exists(select 1 from public.purchase_reversals r where r.user_id=t.user_id and r.original_purchase_id=t.id)
  order by abs((t.occurred_at at time zone 'Asia/Seoul')::date-o.due_on),t.occurred_at desc,t.id limit 50
 ) c
 where o.user_id=(select auth.uid()) and o.id=p_id and not o.excluded and not o.skipped
$$;

create function private.read_recurring_alert(p_id uuid) returns void
language sql security definer set search_path='' as $$
 update public.recurring_web_alerts set read_at=now()
 where user_id=(select auth.uid()) and id=p_id and read_at is null
$$;

create function public.save_recurring_service(p_id uuid,p_expected integer,p_input jsonb) returns jsonb
language sql set search_path='' as $$ select private.save_recurring_service(p_id,p_expected,p_input) $$;
create function public.change_recurring_occurrence(p_id uuid,p_action text,p_transaction uuid,p_final boolean) returns void
language sql set search_path='' as $$ select private.change_recurring_occurrence(p_id,p_action,p_transaction,p_final) $$;
create function public.read_recurring_month(p_month date,p_home boolean default false) returns jsonb
language sql set search_path='' as $$ select private.read_recurring_month(p_month,p_home) $$;
create function public.read_recurring_service_history(p_id uuid) returns jsonb
language sql stable set search_path='' as $$ select private.read_recurring_service_history(p_id) $$;
create function public.read_recurring_candidates(p_id uuid,p_transaction uuid default null) returns jsonb
language sql stable set search_path='' as $$ select private.read_recurring_candidates(p_id,p_transaction) $$;
create function public.read_recurring_alert(p_id uuid) returns void
language sql set search_path='' as $$ select private.read_recurring_alert(p_id) $$;

revoke all on function private.recurring_today(),private.recurring_lock(uuid),private.recurring_name(text),
 private.recurring_schedule(uuid,date,date),private.materialize_recurring(uuid,date,date),private.recurring_state(uuid,date,date),
 private.recurring_match_purchase(),private.recurring_active_alerts(uuid) from public,anon,authenticated;
revoke all on function private.save_recurring_service(uuid,integer,jsonb),public.save_recurring_service(uuid,integer,jsonb),
 private.change_recurring_occurrence(uuid,text,uuid,boolean),public.change_recurring_occurrence(uuid,text,uuid,boolean),
 private.read_recurring_month(date,boolean),public.read_recurring_month(date,boolean),
 private.read_recurring_service_history(uuid),public.read_recurring_service_history(uuid),
 private.read_recurring_candidates(uuid,uuid),public.read_recurring_candidates(uuid,uuid),
 private.read_recurring_alert(uuid),public.read_recurring_alert(uuid) from public,anon,authenticated;
grant execute on function private.save_recurring_service(uuid,integer,jsonb),public.save_recurring_service(uuid,integer,jsonb),
 private.change_recurring_occurrence(uuid,text,uuid,boolean),public.change_recurring_occurrence(uuid,text,uuid,boolean),
 private.read_recurring_month(date,boolean),public.read_recurring_month(date,boolean),
 private.read_recurring_service_history(uuid),public.read_recurring_service_history(uuid),
 private.read_recurring_candidates(uuid,uuid),public.read_recurring_candidates(uuid,uuid),
 private.read_recurring_alert(uuid),public.read_recurring_alert(uuid) to authenticated;
