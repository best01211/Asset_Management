begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','12345678-0000-4000-8000-000000000051',true);
do $$
declare
 uid uuid:=auth.uid();
 first_bank uuid;
 other_bank uuid;
 old_category uuid;
 expense_group uuid;
 food uuid;
 cafe uuid;
 income_id uuid;
 custom uuid;
 draft uuid;
 posted uuid;
 refund uuid;
 tagged uuid;
 summary jsonb;
 found_category jsonb;
begin
 first_bank:=public.create_krw_payment_account('Test wallet','asset');
 other_bank:=public.create_krw_payment_account('Test savings','asset');
 old_category:=public.create_krw_expense_category('Old food category');
 draft:=public.create_pending_expense('Migration test',7000,'2024-01-04T08:00:00+09:00','cash',first_bank,old_category);
 posted:=(public.approve_pending_expense(draft,1,gen_random_uuid())->>'transaction_id')::uuid;

 perform public.initialize_category_catalog();
 perform public.initialize_category_catalog();
 if (select count(*) from public.categories where is_system and transaction_type='expense')<>62
  or (select count(*) from public.categories where is_system and transaction_type='income')<>16
  or (select count(*) from public.category_groups where system_key<>'legacy')<>14
  or (select count(*) from public.tags)<>10 then raise exception 'catalog entries missing or duplicated'; end if;
 if not exists(select 1 from public.categories c join public.category_groups g on g.user_id=c.user_id and g.id=c.parent_id
  where c.id=old_category and c.name='Old food category' and g.system_key='legacy')
  or not exists(select 1 from public.transaction_splits where transaction_id=posted and category_id=old_category)
  then raise exception 'legacy identity changed'; end if;

 select parent_id,id into expense_group,food from public.categories where system_key='food/1';
 perform public.rename_catalog_group(expense_group,'Test expense group');
 if not exists(select 1 from public.category_groups where id=expense_group and name='Test expense group'
  and system_key='food' and transaction_type='expense') then raise exception 'group rename changed identity'; end if;
 select id into cafe from public.categories where system_key='food/2';
 select id into income_id from public.categories where system_key='work/1';
 if not exists(select 1 from public.categories where id=income_id and expense_account_id is null)
  then raise exception 'income category has expense account'; end if;
 custom:=public.save_catalog_category(null,expense_group,'Custom food',55,true);
 perform public.save_catalog_category(custom,expense_group,'Custom renamed',25,true);
 if not exists(select 1 from public.categories where id=custom and name='Custom renamed' and sort_order=25)
  then raise exception 'rename or reorder failed'; end if;
 begin
  perform public.save_catalog_category(food,expense_group,'외식',10,false);
  raise exception 'system category deactivated';
 exception when invalid_parameter_value then null;
 end;
 begin
  perform public.create_pending_expense('Invalid salary choice',7000,'2024-01-04T08:00:00+09:00','cash',first_bank,income_id);
  raise exception 'income passed purchase selection';
 exception when foreign_key_violation or check_violation or invalid_parameter_value or raise_exception then
  if sqlerrm='income passed purchase selection' then raise; end if;
 end;

 refund:=(public.post_account_movement('purchase_refund','2000','2024-01-06T08:00:00+09:00',gen_random_uuid(),null,null,posted)->>'transaction_id')::uuid;
 perform public.post_account_movement('own_transfer','4000','2024-01-07T08:00:00+09:00',gen_random_uuid(),other_bank,first_bank,null);
 perform public.move_transaction_category(posted,old_category,old_category,custom);
 summary:=public.summarize_confirmed_purchases('2024-01-01');
 if summary->>'spending_minor' is distinct from '5000'
  or summary->>'purchase_count' is distinct from '1'
  or not exists(select 1 from jsonb_array_elements(summary->'categories') c where c->>'id'=custom::text and c->>'amount_minor'='5000')
  or exists(select 1 from jsonb_array_elements(summary->'categories') c where c->>'id'=old_category::text)
  or not exists(select 1 from public.refund_allocations where transaction_id=refund and category_id=old_category and amount_minor=2000)
  or not exists(select 1 from public.ledger_entries where transaction_id=posted and side='debit' and amount_minor=7000)
  then raise exception 'refund or transfer incorrectly counted or ledger changed'; end if;
 if public.category_usage(custom)->>'confirmed' is distinct from '2'
  then raise exception 'wrong impact count for purchase and refund'; end if;

 perform public.save_catalog_category(custom,expense_group,'Custom renamed',25,false);
 if not exists(select 1 from public.reporting_purchase_categories where transaction_id=posted and category_id=custom)
  then raise exception 'deactivation removed history'; end if;
 begin
  perform public.create_pending_expense('Inactive choice',7000,'2024-01-04T08:00:00+09:00','cash',first_bank,custom);
  raise exception 'inactive passed purchase selection';
 exception when invalid_parameter_value then
  if sqlerrm<>'CATEGORY_UNAVAILABLE' then raise; end if;
 end;
 begin
  perform public.move_transaction_category(posted,old_category,old_category,cafe);
  raise exception 'stale transaction assignment accepted';
 exception when unique_violation then null;
 end;

 found_category:=public.suggest_expense_category('Unknown merchant',null);
 if found_category->>'source' is distinct from 'unclassified'
  or not exists(select 1 from public.categories where id=(found_category->>'category_id')::uuid and system_key='other/1')
  then raise exception 'uncertain merchant not explicitly unclassified'; end if;
 perform public.save_merchant_category_rule('Migration test',cafe);
 found_category:=public.suggest_expense_category('Migration test',null);
 if found_category->>'source' is distinct from 'merchant_rule' or found_category->>'category_id' is distinct from cafe::text
  then raise exception 'explicit merchant rule did not win'; end if;
 for i in 1..2 loop
  draft:=public.create_pending_expense('Repeated purchase',2000,'2024-01-10T08:00:00+09:00','cash',first_bank,cafe);
  perform public.approve_pending_expense(draft,1,gen_random_uuid());
 end loop;
 found_category:=public.suggest_expense_category('Repeated purchase',null);
 if found_category->>'source' is distinct from 'confirmed_history' or found_category->>'category_id' is distinct from cafe::text
  then raise exception 'confirmed history suggestion not found'; end if;

 perform public.save_transaction_annotation(posted,0,'Test note',array['러닝','메모태그']);
 select id into tagged from public.tags where name='메모태그';
 perform public.save_catalog_tag(tagged,'이름변경');
 if not exists(select 1 from public.transaction_annotations where transaction_id=posted
  and tags=array['러닝','이름변경'] and version=2) then raise exception 'tag rename not linked'; end if;
 perform public.save_catalog_tag(tagged,null);
 if not exists(select 1 from public.transaction_annotations where transaction_id=posted
  and tags=array['러닝'] and version=3 and memo='Test note') then raise exception 'tag removal not linked'; end if;

 perform set_config('request.jwt.claim.sub','12345678-0000-4000-8000-000000000052',true);
 if exists(select 1 from public.category_groups where user_id=uid) or exists(select 1 from public.tags where user_id=uid)
  or exists(select 1 from public.reporting_purchase_categories where transaction_id=posted)
  or exists(select 1 from public.transaction_category_overrides where transaction_id=posted)
  then raise exception 'another user can read category data'; end if;
 begin
  perform public.move_transaction_category(posted,old_category,custom,cafe);
  raise exception 'another user can move category';
 exception when no_data_found then null;
 end;
end
$$;
set constraints all immediate;
rollback;
