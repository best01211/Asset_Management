begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','16161616-1616-4161-8161-111111111111',true);
do $$
declare
 meals uuid;
 goods uuid;
 rule_id uuid;
 modified_id uuid;
begin
 meals := public.create_krw_expense_category('Rule meals');
 goods := public.create_krw_expense_category('Rule goods');
 rule_id := public.save_merchant_category_rule(' Cafe 100% ',meals);
 if public.match_merchant_category('cafe 100%') is distinct from meals
  or public.match_merchant_category('cafe 100') is not null
  or public.match_merchant_category('cafe 100% extra') is not null
 then raise exception 'RULE_MATCH_NOT_EXACT'; end if;
 modified_id := public.save_merchant_category_rule('CAFE 100%',goods);
 if modified_id is distinct from rule_id
  or public.match_merchant_category('Cafe 100%') is distinct from goods
 then raise exception 'RULE_REPLACEMENT_FAILED'; end if;

 perform set_config('request.jwt.claim.sub','16161616-1616-4161-8161-222222222222',true);
 if public.match_merchant_category('Cafe 100%') is not null then raise exception 'OTHER_USER_RULE_VISIBLE'; end if;
 begin
  perform public.save_merchant_category_rule('Cafe 100%',goods);
  raise exception 'EXPECTED_OTHER_USER_CATEGORY_REJECTION';
 exception when no_data_found then
  if sqlerrm<>'RULE_CATEGORY_NOT_FOUND' then raise; end if;
 end;
 if public.save_merchant_category_rule('Cafe 100%',null) is not null then raise exception 'OTHER_USER_RULE_DELETED'; end if;

 perform set_config('request.jwt.claim.sub','16161616-1616-4161-8161-111111111111',true);
 modified_id := public.save_merchant_category_rule('cafe 100%',null);
 if modified_id is distinct from rule_id
  or public.match_merchant_category('Cafe 100%') is not null
 then raise exception 'RULE_REMOVAL_FAILED'; end if;
end
$$;
rollback;
