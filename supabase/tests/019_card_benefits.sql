begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','19191919-1919-4191-8191-111111111111',true);
do $$
declare
 card uuid := public.create_krw_payment_account('Example card','liability');
 bank uuid := public.create_krw_payment_account('Example bank','asset');
 meals uuid := public.create_krw_expense_category('Meals');
 shopping uuid := public.create_krw_expense_category('Shopping');
 request_key uuid := gen_random_uuid();
 registered integer;
 estimate jsonb;
begin
 registered := public.register_card_benefit_terms(card,request_key,'2024-01-01',null,' January terms ',meals,750,'300000','5000');
 if registered<>1 or public.register_card_benefit_terms(
  card,request_key,'2024-01-01',null,'January terms',meals,750,'300000','5000')<>registered
 then raise exception 'TERMS_REGISTRATION_NOT_IDEMPOTENT'; end if;
 begin
  perform public.register_card_benefit_terms(card,request_key,'2024-01-01',null,'January terms',meals,760,'300000','5000');
  raise exception 'EXPECTED_TERMS_REQUEST_CONFLICT';
 exception when unique_violation then
  if sqlerrm<>'CARD_BENEFIT_REQUEST_CONFLICT' then raise; end if;
 end;

 estimate := public.estimate_card_benefit(card,'2024-01-31',meals,'12345','300000','0');
 if estimate->>'estimated_minor' is distinct from '925'
  or estimate->>'source' is distinct from 'January terms'
 then raise exception 'ROUNDING_OR_TERMS_SOURCE_INVALID'; end if;
 estimate := public.estimate_card_benefit(card,'2024-01-31',meals,'12345','300000','4500');
 if estimate->>'estimated_minor' is distinct from '500'
  or estimate->>'remaining_cap_minor' is distinct from '500'
  or public.estimate_card_benefit(card,'2024-01-31',meals,'12345','300000','5100')->>'eligibility' is distinct from 'cap'
  or public.estimate_card_benefit(card,'2024-01-31',shopping,'12345','300000','0')->>'eligibility' is distinct from 'category'
  or public.estimate_card_benefit(card,'2024-01-31',meals,'12345','299999','0')->>'eligibility' is distinct from 'prior_spend'
 then raise exception 'CAP_OR_ELIGIBILITY_INVALID'; end if;

 registered := public.register_card_benefit_terms(card,gen_random_uuid(),'2024-02-01','2024-02-29','February terms',null,500,'0',null);
 if registered<>2
  or public.estimate_card_benefit(card,'2024-01-31',meals,'10000','300000','0')->>'terms_version' is distinct from '1'
  or public.estimate_card_benefit(card,'2024-02-29',shopping,'10000','0','0')->>'estimated_minor' is distinct from '500'
 then raise exception 'EFFECTIVE_TERMS_VERSION_INVALID'; end if;
 begin
  perform public.estimate_card_benefit(card,'2024-03-01',meals,'10000','300000','0');
  raise exception 'EXPECTED_EXPIRED_TERMS';
 exception when no_data_found then
  if sqlerrm<>'BENEFIT_TERMS_NOT_FOUND' then raise; end if;
 end;
 begin
  perform public.register_card_benefit_terms(bank,gen_random_uuid(),'2024-02-01',null,'Invalid',null,500,'0',null);
  raise exception 'EXPECTED_BANK_NOT_ELIGIBLE';
 exception when no_data_found then
  if sqlerrm<>'BENEFIT_CARD_NOT_FOUND' then raise; end if;
 end;
 registered := public.register_card_benefit_terms(card,gen_random_uuid(),'2024-02-01',null,'Corrected February terms',null,10000,'0',null);
 estimate := public.estimate_card_benefit(card,'2024-02-29',null,'9223372036854775807','0','0');
 if registered<>3 or estimate->>'terms_version' is distinct from '3'
  or estimate->>'estimated_minor' is distinct from '9223372036854775807'
  or (select count(*) from public.card_benefit_terms where card_id=card)<>3
  or exists(select 1 from public.transactions)
 then raise exception 'REVISION_OR_ESTIMATE_LEDGER_SIDE_EFFECT'; end if;

 perform set_config('request.jwt.claim.sub','19191919-1919-4191-8191-222222222222',true);
 if exists(select 1 from public.card_benefit_terms) then raise exception 'OTHER_USER_CARD_TERMS_VISIBLE'; end if;
 begin
  perform public.estimate_card_benefit(card,'2024-02-01',null,'10000','0','0');
  raise exception 'EXPECTED_OTHER_USER_ESTIMATE_REJECTED';
 exception when no_data_found then
  if sqlerrm<>'BENEFIT_CARD_NOT_FOUND' then raise; end if;
 end;
end;
$$;
set constraints all immediate;
rollback;
