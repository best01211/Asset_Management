begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','12121212-1212-4121-8121-111111111111',true);
do $$
declare
 uid uuid := auth.uid();
 budget_month constant date := '2024-01-01';
 bank uuid;
 savings uuid;
 expense uuid;
 category uuid;
 draft uuid;
 purchase uuid;
 result jsonb;
begin
 insert into public.financial_accounts(user_id,name,kind) values(uid,'Budget bank','asset') returning id into bank;
 insert into public.financial_accounts(user_id,name,kind) values(uid,'Budget savings','asset') returning id into savings;
 insert into public.financial_accounts(user_id,name,kind) values(uid,'Budget expense','expense') returning id into expense;
 insert into public.categories(user_id,name,expense_account_id) values(uid,'Budget category',expense) returning id into category;
 draft := public.create_pending_expense('Budget purchase',5000,'2024-01-05T10:00:00Z','cash',bank,category);
 purchase := (public.approve_pending_expense(draft,1,gen_random_uuid())->>'transaction_id')::uuid;
 perform public.create_pending_expense('Not approved',8800,'2024-01-05T10:05:00Z','cash',bank,category);
 perform public.post_own_transfer_with_fee('6000','2024-01-06T10:00:00Z',gen_random_uuid(),bank,savings,'200',category);
 perform public.post_account_movement('purchase_refund','1000','2024-01-07T10:00:00Z',gen_random_uuid(),null,null,purchase);

 perform public.save_monthly_budget(budget_month,null,'10000',0);
 perform public.save_monthly_budget(budget_month,category,'5000',0);
 result := public.get_monthly_budget(budget_month);
 if result->>'spent_minor' is distinct from '4200' or result->'total'->>'amount_minor' is distinct from '10000'
  or result->'categories'->0->>'spent_minor' is distinct from '4200'
  or result->'categories'->0->>'amount_minor' is distinct from '5000'
 then raise exception 'WRONG_BUDGET_SPEND_OR_LIMIT: %',result; end if;
 if public.get_monthly_budget('2024-02-01')->'total' is distinct from 'null'::jsonb
 then raise exception 'BUDGET_CARRIED_INTO_ANOTHER_MONTH'; end if;

 result := public.save_monthly_budget(budget_month,category,null,1);
 if result->>'version' is distinct from '2' or result->>'amount_minor' is not null
 then raise exception 'BUDGET_REMOVE_NOT_VERSIONED'; end if;
 result := public.save_monthly_budget(budget_month,category,'0',2);
 if result->>'version' is distinct from '3' or result->>'amount_minor' is distinct from '0'
 then raise exception 'ZERO_BUDGET_TREATED_AS_UNSET'; end if;
 begin
  perform public.save_monthly_budget(budget_month,category,'9000',1);
  raise exception 'EXPECTED_STALE_BUDGET_REJECTION';
 exception when raise_exception then
  if sqlerrm <> 'BUDGET_VERSION_CHANGED' then raise; end if;
 end;

 perform set_config('request.jwt.claim.sub','12121212-1212-4121-8121-222222222222',true);
 result := public.get_monthly_budget(budget_month);
 if result->>'spent_minor' is distinct from '0' or result->'categories' is distinct from '[]'::jsonb
  or result->'total' is distinct from 'null'::jsonb then raise exception 'OTHER_USER_BUDGET_VISIBLE'; end if;
 begin
  perform public.save_monthly_budget(budget_month,category,'1',0);
  raise exception 'EXPECTED_OTHER_USER_CATEGORY_REJECTION';
 exception when no_data_found then
  if sqlerrm <> 'BUDGET_CATEGORY_NOT_FOUND' then raise; end if;
 end;
end
$$;
set constraints all immediate;
rollback;
