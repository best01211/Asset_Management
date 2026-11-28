begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','acc00000-0000-4000-8000-000000000001',true);
do $$
declare
 a uuid:=public.register_investment_account('증권'); b uuid:=public.register_investment_account('외화');
 deposit_id uuid:=gen_random_uuid(); buy_id uuid:=gen_random_uuid(); move_id uuid:=gen_random_uuid();
 req uuid:=gen_random_uuid(); e jsonb; buy jsonb; movement jsonb; summary jsonb;
begin
 e:=jsonb_build_object('new',true,'account',a,'kind','deposit','at','2024-01-01T00:00:00Z',
 'currency','USD','gross','100','rate','1200','fee','0','tax','0','qty','','symbol','','destination','');
 perform public.save_investment_revision(deposit_id,0,req,e);
 perform public.save_investment_revision(deposit_id,0,req,e);
 buy:=e||'{"kind":"buy","at":"2024-02-01T00:00:00Z","symbol":"ABC","qty":"4","gross":"40"}';
 perform public.save_investment_revision(buy_id,0,gen_random_uuid(),buy);
 perform public.save_investment_revision(gen_random_uuid(),0,gen_random_uuid(),buy||'{"kind":"sell","at":"2024-03-01T00:00:00Z","qty":"2","gross":"30","tax":"1"}');
 movement:=e||jsonb_build_object('kind','transfer','gross','50','destination',b,'at','2024-04-01T00:00:00Z');
 perform public.save_investment_revision(move_id,0,gen_random_uuid(),movement);
 summary:=public.get_investment_account(a);
 if (summary#>>'{currency_flows,0,net_flow}')::numeric is distinct from 39 or (summary->>'realized_krw')::numeric is distinct from 10800
 or (public.get_investment_account(b)#>>'{currency_flows,0,net_flow}')::numeric is distinct from 50 then raise exception 'incorrect cash/realized %',summary;end if;
 perform public.save_investment_revision(buy_id,1,gen_random_uuid(),buy||'{"new":false,"gross":"48"}');
 if (public.get_investment_account(a)->>'realized_krw')::numeric is distinct from 6000 then raise exception 'sale not recomputed';end if;
 begin
  perform public.save_investment_revision(buy_id,2,gen_random_uuid(),buy||'{"new":false,"cancelled":true}');
  raise exception 'cancel accepted despite later sale';
 exception when invalid_parameter_value then if sqlerrm<>'INVESTMENT_INSUFFICIENT_HOLDINGS' then raise;end if;end;
 perform public.save_investment_revision(move_id,1,gen_random_uuid(),movement||'{"new":false,"cancelled":true}');
 if public.get_investment_account(b)->'currency_flows' is distinct from '[]'::jsonb then raise exception 'cancelled transfer still active';end if;
 perform public.save_investment_quote('ABC|USD','2024-03-01',25,'statement');
 perform public.save_investment_quote('ABC|USD','2024-03-02',27,'statement');
 if jsonb_array_length(public.read_investment_workspace('ABC|USD')->'quotes')<>2 then raise exception 'price history missing';end if;
 if jsonb_array_length(public.read_investment_workspace()->'quotes')<>1 then raise exception 'quote missing';end if;
 summary:=public.record_investment_event(a,gen_random_uuid(),
 '{"kind":"sell","occurred_at":"2024-05-01T00:00:00Z","symbol":"ABC","currency":"USD","gross":"20","quantity":"1","krw_per_unit":"1300","fee":"0","source":"statement"}');
 if (summary->>'realized_krw')::numeric is distinct from 11600 then raise exception 'legacy sale ignored revised basis';end if;
 perform set_config('request.jwt.claim.sub','acc00000-0000-4000-8000-000000000002',true);
 if public.read_investment_workspace() is distinct from '{"events":[],"accounts":[],"quotes":[]}'::jsonb then raise exception 'cross-user disclosure';end if;
end $$;
rollback;
