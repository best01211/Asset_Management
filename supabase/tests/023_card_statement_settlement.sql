begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','23232323-0000-4000-8000-000000000001',true);
do $$
declare
 bank uuid := public.create_krw_payment_account('Settlement bank','asset');
 card uuid := public.create_krw_payment_account('Settlement card','liability');
 first_bill uuid;
 second_bill uuid;
 payment uuid;
 result jsonb;
begin
 first_bill := public.register_card_statement(card,'2024-03-01','2024-03-15','10000','500','March statement');
 second_bill := public.register_card_statement(card,'2024-04-01','2024-04-15','5000',null,'April statement');
 payment := (public.post_account_movement('card_payment','12000','2024-03-15T10:00:00+09:00',gen_random_uuid(),bank,card)->>'transaction_id')::uuid;
 result := public.allocate_card_statement_payment(first_bill,payment,'10000');
 if result->>'remaining_minor' is distinct from '0' then raise exception 'STATEMENT_NOT_SETTLED'; end if;
 begin
  perform public.allocate_card_statement_payment(second_bill,payment,'2001');
  raise exception 'EXPECTED_PAYMENT_DOUBLE_USE_REJECTION';
 exception when invalid_parameter_value then
  if sqlerrm<>'STATEMENT_ALLOCATION_EXCEEDS_TOTAL' then raise; end if;
 end;
 perform public.allocate_card_statement_payment(second_bill,payment,'2000');
 if public.list_card_statements('2024-04-01')#>>'{0,remaining_minor}' is distinct from '3000'
  or public.list_card_statements('2024-03-01')#>>'{0,benefit_minor}' is distinct from '500'
  or public.summarize_confirmed_purchases('2024-03-01')->>'spending_minor' is distinct from '0'
  or (select count(*) from public.ledger_entries)<>2 then raise exception 'STATEMENT_SETTLEMENT_MUTATED_LEDGER'; end if;
 perform public.allocate_card_statement_payment(second_bill,payment,'0');
 if public.list_card_statements('2024-04-01')#>>'{0,remaining_minor}' is distinct from '5000'
  then raise exception 'ALLOCATION_RELEASE_NOT_APPLIED'; end if;
 perform set_config('request.jwt.claim.sub','23232323-0000-4000-8000-000000000002',true);
 if public.list_card_statements('2024-03-01')<>'[]'::jsonb then raise exception 'OTHER_USER_BILL_VISIBLE'; end if;
end;
$$;
set constraints all immediate;
rollback;
