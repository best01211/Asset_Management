begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','88888888-0000-4000-8000-000000000001',true);
do $$
declare
 uid uuid := auth.uid();
 bank_id uuid;
 card_id uuid;
 expense_id uuid;
 category_id uuid;
 draft_id uuid;
 summary jsonb;
begin
 insert into public.financial_accounts(user_id,name,kind) values(uid,'Summary bank','asset') returning id into bank_id;
 insert into public.financial_accounts(user_id,name,kind) values(uid,'Summary card','liability') returning id into card_id;
 insert into public.financial_accounts(user_id,name,kind) values(uid,'Summary expense','expense') returning id into expense_id;
 insert into public.categories(user_id,name,expense_account_id) values(uid,'Summary category',expense_id) returning id into category_id;

 draft_id := public.create_pending_expense('November KST',99,'2026-11-30T14:59:59.999999Z','cash',bank_id,category_id);
 perform public.approve_pending_expense(draft_id,1,gen_random_uuid());
 draft_id := public.create_pending_expense('December cash',4000,'2026-11-30T15:00:00Z','cash',bank_id,category_id);
 perform public.approve_pending_expense(draft_id,1,gen_random_uuid());
 draft_id := public.create_pending_expense('December credit',5500,'2026-12-01T09:00:00+09:00','credit_card',card_id,category_id);
 perform public.approve_pending_expense(draft_id,1,gen_random_uuid());
 perform public.create_pending_expense('December pending',8100,'2026-12-01T09:05:00+09:00','cash',bank_id,category_id);

 summary := public.summarize_confirmed_purchases('2026-12-01');
 if summary->>'spending_minor' is distinct from '9500' or summary->>'purchase_count' is distinct from '2'
  or summary->'categories'->0->>'amount_minor' is distinct from '9500'
  or summary->'accounts'->0->>'change_minor' is distinct from '-4000'
  or summary->'accounts'->1->>'change_minor' is distinct from '5500'
 then raise exception 'INVALID_DECEMBER_SUMMARY: %',summary; end if;
 if public.summarize_confirmed_purchases('2026-11-01')->>'spending_minor' is distinct from '99'
 then raise exception 'KST_MONTH_BOUNDARY_INCORRECT'; end if;

 perform set_config('request.jwt.claim.sub','88888888-0000-4000-8000-000000000002',true);
 summary := public.summarize_confirmed_purchases('2026-12-01');
 if summary->>'spending_minor' is distinct from '0' or summary->'accounts' is distinct from '[]'::jsonb
  or summary->'categories' is distinct from '[]'::jsonb
 then raise exception 'CROSS_USER_SUMMARY_VISIBLE'; end if;
end
$$;
set constraints all immediate;
rollback;
