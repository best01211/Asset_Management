create table public.investment_accounts (
 user_id uuid not null,
 id uuid not null default gen_random_uuid(),
 name text not null check(length(name) between 1 and 120),
 primary key(user_id,id),
 unique(user_id,name)
);
create table public.investment_events (
 user_id uuid not null,
 id uuid not null default gen_random_uuid(),
 account_id uuid not null,
 request_id uuid not null,
 kind text not null check(kind in ('buy','sell','dividend','fx')),
 occurred_at timestamptz not null,
 symbol text,
 currency text not null check(currency~'^[A-Z]{3}$'),
 quantity numeric,
 gross numeric not null check(gross>0),
 fee numeric not null check(fee>=0),
 krw_per_unit numeric not null check(krw_per_unit>0),
 target_currency text,
 target_amount numeric,
 cost_delta_krw numeric not null default 0,
 realized_krw numeric,
 cash_delta numeric not null,
 source text not null check(length(source) between 1 and 200),
 input jsonb not null,
 primary key(user_id,id),
 unique(user_id,request_id),
 foreign key(user_id,account_id) references public.investment_accounts(user_id,id)
);
create index investment_events_account_time on public.investment_events(user_id,account_id,occurred_at,id);
create index investment_events_position on public.investment_events(user_id,account_id,symbol,currency,occurred_at);
alter table public.investment_accounts enable row level security;
alter table public.investment_events enable row level security;
revoke all on public.investment_accounts,public.investment_events from public,anon,authenticated;
grant select on public.investment_accounts,public.investment_events to authenticated;
create policy investment_accounts_owner on public.investment_accounts for select to authenticated using(user_id=(select auth.uid()));
create policy investment_events_owner on public.investment_events for select to authenticated using(user_id=(select auth.uid()));
create trigger investment_events_immutable before update or delete on public.investment_events
 for each row execute function public.prevent_purchase_reversal_change();

create function public.register_investment_account(p_name text) returns uuid
language plpgsql security definer set search_path='' as $$
declare
 uid uuid := auth.uid();
 account_id uuid;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_name is null or length(btrim(p_name)) not between 1 and 120 then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 insert into public.investment_accounts(user_id,name) values(uid,btrim(p_name))
 on conflict(user_id,name) do nothing returning id into account_id;
 if account_id is null then
  select id into account_id from public.investment_accounts where user_id=uid and name=btrim(p_name);
 end if;
 return account_id;
end;
$$;

create function public.record_investment_event(p_account_id uuid,p_request_id uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 uid uuid := auth.uid();
 previous public.investment_events%rowtype;
 event_date timestamptz;
 event_kind text := p_data->>'kind';
 instrument text := p_data->>'symbol';
 denom text := p_data->>'currency';
 target text := p_data->>'target_currency';
 receipt text := btrim(p_data->>'source');
 units numeric;
 gross_value numeric;
 costs numeric;
 rate numeric;
 received numeric;
 open_units numeric;
 open_cost numeric;
 basis_delta numeric := 0;
 gain numeric;
 flow numeric;
 result_id uuid;
 decimal_amount constant text := '^(0|[1-9][0-9]{0,17})([.][0-9]{1,8})?$';
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_account_id is null or p_request_id is null or jsonb_typeof(p_data) is distinct from 'object'
  or coalesce(event_kind,'') not in ('buy','sell','dividend','fx') or coalesce(denom,'') !~ '^[A-Z]{3}$'
  or coalesce(length(receipt),0) not between 1 and 200
  or coalesce(p_data->>'gross','') !~ decimal_amount or coalesce(p_data->>'fee','') !~ decimal_amount
  or coalesce(p_data->>'krw_per_unit','') !~ decimal_amount
  or coalesce(p_data->>'occurred_at','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
  or (event_kind='fx' and (instrument is not null or p_data->>'quantity' is not null or coalesce(target,'') !~ '^[A-Z]{3}$'
   or target=denom or coalesce(p_data->>'target_amount','') !~ decimal_amount))
  or (event_kind<>'fx' and (coalesce(instrument,'') !~ '^[A-Z0-9][A-Z0-9.:-]{0,39}$'
   or target is not null or p_data->>'target_amount' is not null))
  or (event_kind in ('buy','sell') and coalesce(p_data->>'quantity','') !~ decimal_amount)
  or (event_kind='dividend' and p_data->>'quantity' is not null) then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;
 event_date := (p_data->>'occurred_at')::timestamptz;
 gross_value := (p_data->>'gross')::numeric;
 costs := (p_data->>'fee')::numeric;
 rate := (p_data->>'krw_per_unit')::numeric;
 units := (p_data->>'quantity')::numeric;
 received := (p_data->>'target_amount')::numeric;
 if event_date>statement_timestamp() or gross_value<=0 or rate<=0 or units<=0 or received<=0
  or (denom='KRW' and rate<>1) or (event_kind in ('sell','dividend') and costs>gross_value) then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('invest:'||uid::text||':'||p_request_id::text,0));
 select * into previous from public.investment_events where user_id=uid and request_id=p_request_id;
 if found then
  if previous.account_id<>p_account_id or previous.input is distinct from p_data then raise exception 'INVESTMENT_REQUEST_CONFLICT' using errcode='23505'; end if;
  return jsonb_build_object('id',previous.id,'replayed',true,'realized_krw',previous.realized_krw::text);
 end if;
 perform 1 from public.investment_accounts where user_id=uid and id=p_account_id for update;
 if not found then raise exception 'INVESTMENT_ACCOUNT_NOT_FOUND' using errcode='P0002'; end if;

 if event_kind in ('buy','sell') then
  if exists (select 1 from public.investment_events e where e.user_id=uid and e.account_id=p_account_id
   and e.symbol=instrument and e.currency=denom and e.kind in ('buy','sell') and e.occurred_at>event_date)
  then raise exception 'INVESTMENT_TRADE_OUT_OF_ORDER' using errcode='22023'; end if;
  if event_kind='buy' then
   basis_delta := (gross_value+costs)*rate;
   flow := -gross_value-costs;
  else
   select coalesce(sum(e.quantity),0),coalesce(sum(e.cost_delta_krw),0) into open_units,open_cost
   from public.investment_events e where e.user_id=uid and e.account_id=p_account_id and e.symbol=instrument and e.currency=denom;
   if open_units<units then raise exception 'INVESTMENT_INSUFFICIENT_HOLDINGS' using errcode='22023'; end if;
   basis_delta := -case when open_units=units then open_cost else least(open_cost,round(open_cost*units/open_units,8)) end;
   flow := gross_value-costs;
   gain := flow*rate+basis_delta;
   units := -units;
  end if;
 elsif event_kind='dividend' then
  flow := gross_value-costs;
 else
  flow := -gross_value-costs;
 end if;
 insert into public.investment_events(user_id,account_id,request_id,kind,occurred_at,symbol,currency,quantity,gross,fee,krw_per_unit,
  target_currency,target_amount,cost_delta_krw,realized_krw,cash_delta,source,input)
 values(uid,p_account_id,p_request_id,event_kind,event_date,instrument,denom,units,gross_value,costs,rate,
  target,received,basis_delta,gain,flow,receipt,p_data) returning id into result_id;
 return jsonb_build_object('id',result_id,'replayed',false,'realized_krw',gain::text);
end;
$$;

create function public.get_investment_account(p_account_id uuid) returns jsonb
language sql stable set search_path='' as $$
 with account as (
  select * from public.investment_accounts where user_id=(select auth.uid()) and id=p_account_id
 ), events as materialized (
  select e.* from public.investment_events e join account a on a.user_id=e.user_id and a.id=e.account_id
 ), positions as (
  select symbol,currency,sum(quantity)::text as quantity,sum(cost_delta_krw)::text as cost_krw
  from events group by symbol,currency having sum(quantity)>0
 ), flows as (
  select currency,sum(amount)::text as net_flow from (
   select currency,cash_delta as amount from events union all
   select target_currency,target_amount from events where kind='fx'
  ) f group by currency
 )
 select jsonb_build_object('id',a.id,'name',a.name,
  'positions',coalesce((select jsonb_agg(to_jsonb(p) order by p.symbol,p.currency) from positions p),'[]'::jsonb),
  'currency_flows',coalesce((select jsonb_agg(to_jsonb(f) order by f.currency) from flows f),'[]'::jsonb),
  'realized_krw',(select coalesce(sum(e.realized_krw),0)::text from events e),
  'net_dividend_krw',(select coalesce(sum(e.cash_delta*e.krw_per_unit) filter(where kind='dividend'),0)::text from events e)
 ) from account a
$$;

create function public.value_investment_positions(p_account_id uuid,p_quotes jsonb) returns jsonb
language plpgsql stable set search_path='' as $$
declare
 portfolio jsonb;
 result jsonb;
 decimal_amount constant text := '^(0|[1-9][0-9]{0,17})([.][0-9]{1,8})?$';
begin
 if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 portfolio := public.get_investment_account(p_account_id);
 if portfolio is null then raise exception 'INVESTMENT_ACCOUNT_NOT_FOUND' using errcode='P0002'; end if;
 if jsonb_typeof(p_quotes) is distinct from 'array' then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 if jsonb_array_length(p_quotes)>100 or exists(
  select 1 from jsonb_array_elements(p_quotes) q where jsonb_typeof(q)<>'object'
   or coalesce(q->>'symbol','') !~ '^[A-Z0-9][A-Z0-9.:-]{0,39}$'
   or coalesce(q->>'currency','') !~ '^[A-Z]{3}$'
   or coalesce(q->>'unit_price','') !~ decimal_amount or coalesce(q->>'krw_per_unit','') !~ decimal_amount
   or coalesce(q->>'as_of','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   or coalesce(length(btrim(q->>'source')),0) not between 1 and 200
 ) then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 if exists(
  select 1 from jsonb_to_recordset(p_quotes) q(symbol text,currency text,unit_price numeric,krw_per_unit numeric,as_of date)
  where unit_price<=0 or krw_per_unit<=0 or (currency='KRW' and krw_per_unit<>1)
   or as_of>(statement_timestamp() at time zone 'Asia/Seoul')::date
 ) or exists(
  select 1 from jsonb_array_elements(p_quotes) q group by q->>'symbol',q->>'currency' having count(*)>1
 ) then raise exception 'INVALID_INVESTMENT_QUOTE' using errcode='22023'; end if;

 with quoted as (
  select p.symbol,p.currency,p.quantity,p.cost_krw,q.unit_price,q.krw_per_unit,q.as_of,q.source,
   p.quantity*q.unit_price*q.krw_per_unit as value_krw
  from jsonb_to_recordset(portfolio->'positions') p(symbol text,currency text,quantity numeric,cost_krw numeric)
  left join jsonb_to_recordset(p_quotes) q(symbol text,currency text,unit_price numeric,krw_per_unit numeric,as_of date,source text)
   on q.symbol=p.symbol and q.currency=p.currency
 )
 select jsonb_build_object('known_value_krw',sum(q.value_krw)::text,
  'unquoted_positions',count(*) filter(where q.value_krw is null),'positions',coalesce(jsonb_agg(jsonb_build_object(
   'symbol',q.symbol,'currency',q.currency,'quantity',q.quantity::text,'cost_krw',q.cost_krw::text,
   'value_krw',q.value_krw::text,'unrealized_krw',(q.value_krw-q.cost_krw)::text,
   'unit_price',q.unit_price::text,'krw_per_unit',q.krw_per_unit::text,'as_of',q.as_of,'source',q.source
  ) order by q.symbol,q.currency),'[]'::jsonb)) into result from quoted q;
 return result;
end;
$$;
revoke all on function public.register_investment_account(text),public.record_investment_event(uuid,uuid,jsonb),
 public.get_investment_account(uuid),public.value_investment_positions(uuid,jsonb) from public,anon;
grant execute on function public.register_investment_account(text),public.record_investment_event(uuid,uuid,jsonb),
 public.get_investment_account(uuid),public.value_investment_positions(uuid,jsonb) to authenticated;
