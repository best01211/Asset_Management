begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','12121212-1212-4121-8121-333333333333',true);

do $$
declare
 bank uuid:=public.create_krw_payment_account('Workspace checking','asset');
 savings uuid:=public.create_krw_payment_account('Workspace savings','asset');
 category uuid:=public.create_krw_expense_category('Workspace category');
 service_id uuid:=gen_random_uuid();
 draft uuid;
 purchase uuid;
 occurrence uuid;
 period constant date:='2024-04-01';
 result jsonb;
 settings jsonb;
begin
 perform public.save_budget_allocations(period,jsonb_build_array(
  jsonb_build_object('category_id',null,'amount_minor','15000','expected_version',0),
  jsonb_build_object('category_id',category,'amount_minor','20000','expected_version',0)));
 begin
  perform public.save_budget_allocations(period,jsonb_build_array(
   jsonb_build_object('category_id',null,'amount_minor','90000','expected_version',1),
   jsonb_build_object('category_id',category,'amount_minor','21000','expected_version',0)));
  raise exception 'expected stale budget rejection';
 exception when raise_exception then
  if sqlerrm<>'BUDGET_VERSION_CHANGED' then raise; end if;
 end;
 if public.get_monthly_budget(period)->'total'->>'amount_minor'<>'15000' then raise exception 'batch leaked partial save'; end if;

 perform public.save_monthly_budget('2024-03-01',null,'10000',0);
 draft:=public.create_pending_expense('Variable workspace purchase',5000,'2024-04-05T17:00:00Z','cash',bank,category);
 purchase:=(public.approve_pending_expense(draft,1,gen_random_uuid())->>'transaction_id')::uuid;
 perform public.create_pending_expense('Waiting workspace purchase',8800,'2024-04-05T10:00:00Z','cash',bank,category);
 perform public.post_own_transfer_with_fee('6000','2024-04-07T10:00:00Z',gen_random_uuid(),bank,savings,'200',category);
 perform public.post_account_movement('purchase_refund','1000','2024-04-08T10:00:00Z',gen_random_uuid(),null,null,purchase);

 settings:=jsonb_build_object('name','Workspace subscription','amount_minor','9000','currency','KRW',
  'anchor_on','2024-04-10','effective_on','2024-04-01','cycle_unit','month','cycle_count',1,'status','active',
  'account_id',bank,'category_id',category,'aliases',array[]::text[],'auto_match',true,'web_enabled',false,
  'advance_days',0,'unmatched_alert',false,'push_enabled',false,'note','');
 perform public.save_recurring_service(service_id,0,settings);
 result:=public.read_budget_workspace(period);
 if result->>'spent_minor'<>'4200' or result->'scheduled'->0->>'remaining_minor'<>'9000'
  or result->'pending'->>'won_minor'<>'8800' or result->'pending'->>'count'<>'1'
  or result->'previous'->'total'->>'amount_minor'<>'10000' then raise exception 'incorrect budget inputs %',result; end if;
 occurrence:=(result->'scheduled'->0->>'id')::uuid;
 if not exists(select 1 from jsonb_array_elements(result->'daily') r where r->>'day'='2024-04-06' and r->>'amount_minor'='5000')
  or (select sum((r->>'amount_minor')::numeric) from jsonb_array_elements(result->'daily') r where r->>'category_id' is null)<>4200
 then raise exception 'wrong daily ledger or Seoul day %',result; end if;

 draft:=public.create_pending_expense('Workspace subscription',8000,'2024-04-10T10:00:00Z','cash',bank,category);
 purchase:=(public.approve_pending_expense(draft,1,gen_random_uuid())->>'transaction_id')::uuid;
 perform public.change_recurring_occurrence(occurrence,'link',purchase,false);
 result:=public.read_budget_workspace(period);
 if result->>'spent_minor'<>'12200' or result->'scheduled'->0->>'remaining_minor'<>'1000'
  or not exists(select 1 from jsonb_array_elements(result->'daily') r where r->>'category_id'=category::text
   and r->>'day'='2024-04-10' and r->>'variable_minor'='0') then raise exception 'linked payment counted again %',result; end if;
 perform public.change_recurring_occurrence(occurrence,'unlink',purchase,false);
 perform public.change_recurring_occurrence(occurrence,'link',purchase,true);
 if public.read_budget_workspace(period)->'scheduled'<>'[]'::jsonb then raise exception 'closed occurrence still pending'; end if;
 perform public.reverse_confirmed_purchase(purchase,'Workspace reversal');
 result:=public.read_budget_workspace(period);
 if result->>'spent_minor'<>'4200' or result->'scheduled'->0->>'remaining_minor'<>'9000' then
  raise exception 'reversal not reflected in budget %',result; end if;

 perform set_config('request.jwt.claim.sub','12121212-1212-4121-8121-444444444444',true);
 result:=public.read_budget_workspace(period);
 if result->>'spent_minor'<>'0' or result->'scheduled'<>'[]'::jsonb or result->'daily'<>'[]'::jsonb
   or result->'total'<>'null'::jsonb then raise exception 'workspace disclosed another user data'; end if;
end
$$;

set constraints all immediate;
rollback;
