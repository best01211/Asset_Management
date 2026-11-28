-- Immutable journal overlays existing events. Corrections preserve both the source and every revision.
create table public.investment_revisions(
 user_id uuid not null, event_id uuid not null, version integer not null check(version>0),
 sequence bigint generated always as identity, request_id uuid not null, payload jsonb not null,
 primary key(user_id,event_id,version), unique(user_id,request_id)
);
create table public.investment_quotes(
 user_id uuid not null, asset_key text not null, as_of timestamptz not null,
 value numeric not null check(value>0), source text not null check(length(source) between 1 and 120),
 primary key(user_id,asset_key,as_of)
);
alter table public.investment_revisions enable row level security;
alter table public.investment_quotes enable row level security;
revoke all on public.investment_revisions,public.investment_quotes from public,anon,authenticated;
grant select on public.investment_revisions,public.investment_quotes to authenticated;
create policy own_investment_revisions on public.investment_revisions for select to authenticated using(user_id=(select auth.uid()));
create policy own_investment_quotes on public.investment_quotes for select to authenticated using(user_id=(select auth.uid()));

create function public.investment_workspace_events() returns setof jsonb
language sql stable security invoker set search_path='' as $$
 with history as (
 select e.id,0 as version,0::bigint as seq,jsonb_build_object(
 'id',e.id,'version',0,'account',e.account_id,'kind',e.kind,'at',e.occurred_at,'symbol',coalesce(e.symbol,''),
 'qty',coalesce(abs(e.quantity)::text,''),'currency',e.currency,'rate',e.krw_per_unit::text,
 'gross',e.gross::text,'fee',e.fee::text,'tax','0','name',coalesce(e.symbol,''),'exchange','',
 'category','unknown','target',coalesce(e.target_currency,''),'received',coalesce(e.target_amount::text,''),
 'destination','','memo',e.source,'legacy',true) as data
 from public.investment_events e where e.user_id=(select auth.uid())
 union all
 select event_id,version,min(sequence) over(partition by event_id),payload||jsonb_build_object('id',event_id,'version',version)
 from public.investment_revisions where user_id=(select auth.uid())
 ), current_events as (select distinct on(id) * from history order by id,version desc)
 select data from current_events order by (data->>'at')::timestamptz,seq,case when data->>'kind'='buy' then 0 else 1 end,id
$$;

create function public.read_investment_workspace(p_history_key text default null) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by name) from public.investment_accounts where user_id=(select auth.uid())),'[]'::jsonb),
 'events',coalesce((select jsonb_agg(e) from public.investment_workspace_events() e),'[]'::jsonb),
 'quotes',coalesce((select jsonb_agg(jsonb_build_object('key',asset_key,'at',as_of,'value',value::text,'source',source) order by as_of)
 from (
   select distinct on (asset_key) * from public.investment_quotes
   where user_id=(select auth.uid()) and p_history_key is distinct from 'analysis' and asset_key is distinct from p_history_key order by asset_key,as_of desc
 ) latest_or_other),'[]'::jsonb) || coalesce((select jsonb_agg(jsonb_build_object(
   'key',asset_key,'at',as_of,'value',value::text,'source',source) order by as_of)
   from public.investment_quotes where user_id=(select auth.uid()) and (p_history_key='analysis' or asset_key=p_history_key)),'[]'::jsonb))
$$;

-- Replay in accounting order under the writer lock. Older unfunded trade history remains readable.
create function public.investment_account_projection(p_account uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare
 e jsonb; k text; c text; sym text; pos text; positions jsonb:='{}'; cash jsonb:='{}';
 units numeric; cost numeric; flow numeric; amount numeric; fee numeric; rate numeric; q numeric;
 realized numeric:=0; dividends numeric:=0; incoming boolean; removed numeric;
begin
 if not exists(select 1 from public.investment_accounts where user_id=auth.uid() and id=p_account) then return null; end if;
 for e in select * from public.investment_workspace_events() loop
  if coalesce((e->>'cancelled')::boolean,false) then continue; end if;
  incoming:=e->>'kind'='transfer' and e->>'destination'=p_account::text;
  if not incoming and e->>'account'<>p_account::text then continue; end if;
  k:=e->>'kind'; c:=e->>'currency'; sym:=e->>'symbol'; pos:=sym||'|'||c;
  amount:=(e->>'gross')::numeric; fee:=(e->>'fee')::numeric+(e->>'tax')::numeric;
  rate:=nullif(e->>'rate','')::numeric; q:=nullif(e->>'qty','')::numeric;
  if k in ('buy','sell') then
   units:=coalesce((positions->pos->>'quantity')::numeric,0); cost:=coalesce((positions->pos->>'cost_krw')::numeric,0);
   if k='buy' then units:=units+q; cost:=cost+round((amount+fee)*rate,8); flow:=-amount-fee;
   else
    if units<q then raise exception 'INVESTMENT_INSUFFICIENT_HOLDINGS' using errcode='22023'; end if;
    removed:=round(cost*q/units,8); units:=units-q; cost:=cost-removed; flow:=amount-fee; realized:=realized+round(flow*rate,8)-removed;
   end if;
   positions:=jsonb_set(positions,array[pos],jsonb_build_object('symbol',sym,'currency',c,'quantity',units::text,'cost_krw',cost::text));
  elsif k='dividend' then flow:=amount-fee; dividends:=dividends+round(flow*rate,8);
  elsif k='deposit' or incoming then flow:=amount;
  elsif k='fx' then
   flow:=-amount-fee;
   cash:=jsonb_set(cash,array[e->>'target'],to_jsonb(coalesce((cash->>(e->>'target'))::numeric,0)+(e->>'received')::numeric));
  else flow:=-amount; end if;
  amount:=coalesce((cash->>c)::numeric,0)+flow;
  if amount<0 and flow<0 and not coalesce((e->>'legacy')::boolean,false) then
   raise exception 'INVESTMENT_INSUFFICIENT_CASH' using errcode='22023';
  end if;
  cash:=jsonb_set(cash,array[c],to_jsonb(amount));
 end loop;
 return jsonb_build_object('id',p_account,'name',(select name from public.investment_accounts where user_id=auth.uid() and id=p_account),
 'positions',coalesce((select jsonb_agg(value order by key) from jsonb_each(positions) where (value->>'quantity')::numeric>0),'[]'::jsonb),
 'currency_flows',coalesce((select jsonb_agg(jsonb_build_object('currency',key,'net_flow',value) order by key) from jsonb_each_text(cash)),'[]'::jsonb),
 'realized_krw',realized::text,'net_dividend_krw',dividends::text);
end $$;
create or replace function public.get_investment_account(p_account_id uuid) returns jsonb
language sql stable set search_path='' as $$select public.investment_account_projection(p_account_id)$$;

create function public.save_investment_revision(p_id uuid,p_version integer,p_request uuid,p_data jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); current_event jsonb; old_request public.investment_revisions%rowtype;
 pattern constant text:='^(0|[1-9][0-9]{0,17})([.][0-9]{1,8})?$'; k text:=p_data->>'kind'; c text:=p_data->>'currency'; a uuid;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 perform pg_advisory_xact_lock(hashtextextended('investment-workspace:'||uid::text,0));
 select * into old_request from public.investment_revisions where user_id=uid and request_id=p_request;
 if found then
  if old_request.event_id=p_id and old_request.payload=p_data and old_request.version=p_version+1 then return; end if;
  raise exception 'INVESTMENT_REQUEST_CONFLICT' using errcode='23505';
 end if;
 select e into current_event from public.investment_workspace_events() e where e->>'id'=p_id::text;
 if p_version is distinct from coalesce((current_event->>'version')::integer,0)
 or (current_event is not null and p_data->>'new'='true') or (current_event is null and coalesce(p_data->>'new','false')<>'true')
 or coalesce((current_event->>'cancelled')::boolean,false) then raise exception 'INVESTMENT_VERSION_CONFLICT' using errcode='23505'; end if;
 if p_data ? 'legacy' or jsonb_typeof(p_data) is distinct from 'object' or length(p_data::text)>4800 or
 exists(select 1 from jsonb_each(p_data) f where jsonb_typeof(f.value) <>
   case when f.key in ('new','cancelled') then 'boolean' else 'string' end) or
 coalesce(k,'') not in ('buy','sell','dividend','fx','deposit','withdraw','transfer') or coalesce(c,'') !~ '^[A-Z]{3}$'
 or coalesce(p_data->>'gross','') !~ pattern or (p_data->>'gross')::numeric<=0
 or coalesce(p_data->>'fee','') !~ pattern or coalesce(p_data->>'tax','') !~ pattern
 or coalesce(p_data->>'at','') !~ '^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$' or (p_data->>'at')::timestamptz>statement_timestamp()
 or (not (k in ('deposit','transfer','withdraw') and coalesce(p_data->>'rate','')='') and
 (coalesce(p_data->>'rate','') !~ pattern or (p_data->>'rate')::numeric<=0 or (c='KRW' and (p_data->>'rate')::numeric<>1)))
 or (k in ('buy','sell','dividend') and coalesce(p_data->>'symbol','') !~ '^[A-Z0-9][A-Z0-9.:-]{0,39}$')
 or (k in ('buy','sell') and (coalesce(p_data->>'qty','') !~ pattern or (p_data->>'qty')::numeric<=0))
 or (k in ('sell','dividend') and (p_data->>'gross')::numeric<(p_data->>'fee')::numeric+(p_data->>'tax')::numeric)
 or (k in ('deposit','withdraw','transfer') and (p_data->>'fee')::numeric+(p_data->>'tax')::numeric<>0)
 or (k='fx' and (coalesce(p_data->>'target','') !~ '^[A-Z]{3}$' or c=p_data->>'target' or
 coalesce(p_data->>'received','') !~ pattern or (p_data->>'received')::numeric<=0))
 or not exists(select 1 from public.investment_accounts where user_id=uid and id=(p_data->>'account')::uuid)
 or (k='transfer' and (p_data->>'destination'=p_data->>'account' or not exists(select 1 from public.investment_accounts where user_id=uid and id=(p_data->>'destination')::uuid)))
 then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 if current_event is null and coalesce((p_data->>'cancelled')::boolean,false) then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 insert into public.investment_revisions(user_id,event_id,version,request_id,payload) values(uid,p_id,p_version+1,p_request,p_data);
 for a in select distinct v::uuid from unnest(array[current_event->>'account',current_event->>'destination',p_data->>'account',p_data->>'destination']) v where nullif(v,'') is not null
 loop perform public.investment_account_projection(a); end loop;
end $$;

create function public.save_investment_quote(p_key text,p_as_of timestamptz,p_value numeric,p_source text) returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_key !~ '^([A-Z0-9][A-Z0-9.:-]{0,39})?[|][A-Z]{3}$' or p_as_of>statement_timestamp()
 or p_value::text !~ '^[0-9]{1,18}([.][0-9]{1,8})?$' or p_value<=0 then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 insert into public.investment_quotes values(auth.uid(),p_key,p_as_of,p_value,btrim(p_source))
 on conflict(user_id,asset_key,as_of) do update set value=excluded.value,source=excluded.source;
end $$;
revoke all on function public.investment_workspace_events(),public.read_investment_workspace(text),public.investment_account_projection(uuid),
 public.save_investment_revision(uuid,integer,uuid,jsonb),public.save_investment_quote(text,timestamptz,numeric,text) from public,anon;
grant execute on function public.investment_workspace_events(),public.read_investment_workspace(text),public.investment_account_projection(uuid),
 public.save_investment_revision(uuid,integer,uuid,jsonb),public.save_investment_quote(text,timestamptz,numeric,text) to authenticated;

create or replace function public.record_investment_event(p_account_id uuid,p_request_id uuid,p_data jsonb) returns jsonb
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
 perform pg_advisory_xact_lock(hashtextextended('investment-workspace:'||uid::text,0));
 perform pg_advisory_xact_lock(hashtextextended('invest:'||uid::text||':'||p_request_id::text,0));
 select * into previous from public.investment_events where user_id=uid and request_id=p_request_id;
 if found then
  if previous.account_id<>p_account_id or previous.input is distinct from p_data then raise exception 'INVESTMENT_REQUEST_CONFLICT' using errcode='23505'; end if;
  return jsonb_build_object('id',previous.id,'replayed',true,'realized_krw',previous.realized_krw::text);
 end if;
 perform 1 from public.investment_accounts where user_id=uid and id=p_account_id for update;
 if not found then raise exception 'INVESTMENT_ACCOUNT_NOT_FOUND' using errcode='P0002'; end if;

 if event_kind in ('buy','sell') then
  if exists(select 1 from public.investment_workspace_events() e where e->>'account'=p_account_id::text
   and not coalesce((e->>'cancelled')::boolean,false) and e->>'symbol'=instrument and e->>'currency'=denom
   and e->>'kind' in ('buy','sell') and (e->>'at')::timestamptz>event_date)  then raise exception 'INVESTMENT_TRADE_OUT_OF_ORDER' using errcode='22023'; end if;
  if event_kind='buy' then
   basis_delta := (gross_value+costs)*rate;
   flow := -gross_value-costs;
  else
   select (p->>'quantity')::numeric,(p->>'cost_krw')::numeric into open_units,open_cost
   from jsonb_array_elements(public.investment_account_projection(p_account_id)->'positions') p
   where p->>'symbol'=instrument and p->>'currency'=denom;
   open_units:=coalesce(open_units,0);   if open_units<units then raise exception 'INVESTMENT_INSUFFICIENT_HOLDINGS' using errcode='22023'; end if;
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
 perform public.investment_account_projection(p_account_id);
 return jsonb_build_object('id',result_id,'replayed',false,'realized_krw',gain::text);
end;
$$;
