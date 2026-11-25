begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','24242424-0000-4000-8000-000000000001',true);
do $$
declare
 account uuid := public.register_investment_account('Investment account');
 trade jsonb;
 result jsonb;
 buy_request uuid := gen_random_uuid();
begin
 trade := '{"kind":"buy","symbol":"XNAS:EXAMPLE","currency":"USD","quantity":"10","gross":"100","fee":"2","krw_per_unit":"1200","source":"Fixture statement","occurred_at":"2024-01-01T01:00:00Z"}';
 result := public.record_investment_event(account,buy_request,trade);
 if result->>'replayed' is distinct from 'false' then raise exception 'BUY_NOT_CREATED'; end if;
 result := public.record_investment_event(account,buy_request,trade);
 if result->>'replayed' is distinct from 'true' then raise exception 'BUY_NOT_REPLAYED'; end if;
 trade := '{"kind":"sell","symbol":"XNAS:EXAMPLE","currency":"USD","quantity":"4","gross":"60","fee":"1","krw_per_unit":"1300","source":"Fixture statement","occurred_at":"2024-01-02T01:00:00Z"}';
 result := public.record_investment_event(account,gen_random_uuid(),trade);
 if (result->>'realized_krw')::numeric<>27740 then raise exception 'SELL_PROFIT_INCORRECT'; end if;
 begin
  perform public.record_investment_event(account,gen_random_uuid(),jsonb_set(trade,'{quantity}','"7"'));
  raise exception 'EXPECTED_NEGATIVE_POSITION_REJECTION';
 exception when invalid_parameter_value then
  if sqlerrm<>'INVESTMENT_INSUFFICIENT_HOLDINGS' then raise; end if;
 end;
 perform public.record_investment_event(account,gen_random_uuid(),'{"kind":"dividend","symbol":"XNAS:EXAMPLE","currency":"USD","gross":"7","fee":"2","krw_per_unit":"1300","source":"Fixture withholding","occurred_at":"2024-01-03T01:00:00Z"}');
 perform public.record_investment_event(account,gen_random_uuid(),'{"kind":"fx","currency":"KRW","gross":"130000","fee":"500","krw_per_unit":"1","target_currency":"USD","target_amount":"100","source":"Fixture FX","occurred_at":"2024-01-04T01:00:00Z"}');
 result := public.get_investment_account(account);
 if (result#>>'{positions,0,cost_krw}')::numeric<>73440 or result#>>'{positions,0,quantity}' is distinct from '6'
  or (result->>'net_dividend_krw')::numeric<>6500
  or (result#>>'{currency_flows,0,net_flow}')::numeric<>-130500
  or (result#>>'{currency_flows,1,net_flow}')::numeric<>62
  or exists(select 1 from public.ledger_entries) then raise exception 'INVESTMENT_TOTALS_OR_SPENDING_INCORRECT: %',result; end if;
 result := public.value_investment_positions(account,'[{"symbol":"XNAS:EXAMPLE","currency":"USD","unit_price":"12","krw_per_unit":"1400","as_of":"2024-01-05","source":"Fixture quote"}]');
 if (result->>'known_value_krw')::numeric<>100800 or (result#>>'{positions,0,unrealized_krw}')::numeric<>27360
  or result#>>'{positions,0,source}' is distinct from 'Fixture quote'
  or public.value_investment_positions(account,'[]')->>'unquoted_positions' is distinct from '1'
 then raise exception 'INVESTMENT_VALUATION_INCORRECT: %',result; end if;
 perform set_config('request.jwt.claim.sub','24242424-0000-4000-8000-000000000002',true);
 if public.get_investment_account(account) is not null or exists(select 1 from public.investment_events)
 then raise exception 'OTHER_USER_INVESTMENT_VISIBLE'; end if;
end;
$$;
rollback;
