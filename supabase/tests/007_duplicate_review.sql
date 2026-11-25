begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','77777777-0000-4000-8000-000000000001',true);
do $$
declare
 owner_id uuid := auth.uid();
 moment constant timestamptz := '2026-11-25T12:15:00+09:00';
 account_id uuid;
 expense_id uuid;
 category_id uuid;
 original_id uuid;
 suspected_id uuid;
 decision jsonb;
begin
 insert into public.financial_accounts(user_id,name,kind)
 values(owner_id,'Duplicate test bank','asset') returning id into account_id;
 insert into public.financial_accounts(user_id,name,kind)
 values(owner_id,'Duplicate test expense','expense') returning id into expense_id;
 insert into public.categories(user_id,name,expense_account_id)
 values(owner_id,'Duplicate test category',expense_id) returning id into category_id;
 original_id := public.create_pending_expense('Shop',5500,moment,'debit_card',account_id,category_id);
 suspected_id := public.create_pending_expense('Shop',5500,moment+interval '5 seconds','debit_card',account_id,category_id);
 perform public.approve_pending_expense(original_id,1,gen_random_uuid());
 if public.list_pending_duplicate_candidates(suspected_id)->'candidates'->0->>'id' is distinct from original_id::text
 then raise exception 'ORIGINAL_CANDIDATE_MISSING'; end if;

 decision := public.review_pending_duplicate(suspected_id,1,'flag',original_id);
 if decision->>'version' is distinct from '2'
  or public.list_pending_duplicate_candidates(suspected_id)->>'linked_id' is distinct from original_id::text
 then raise exception 'DUPLICATE_LINK_NOT_STORED'; end if;

 begin
  perform public.approve_pending_expense(suspected_id,2,gen_random_uuid());
  raise exception 'EXPECTED_SUSPECTED_APPROVAL_REJECTION';
 exception when raise_exception then
  if sqlerrm <> 'STALE_OR_NOT_REVIEWABLE' then raise; end if;
 end;

 decision := public.review_pending_duplicate(suspected_id,2,'keep');
 if decision->>'status' is distinct from 'pending_review'
  or public.list_pending_duplicate_candidates(suspected_id)->>'linked_id' is not null
 then raise exception 'DUPLICATE_LINK_NOT_CLEARED'; end if;

 perform public.review_pending_duplicate(suspected_id,3,'flag',original_id);
 decision := public.review_pending_duplicate(suspected_id,4,'dismiss');
 if decision->>'status' is distinct from 'dismissed'
  or not exists (select 1 from public.pending_transactions where id=suspected_id and duplicate_of_pending_id=original_id)
  or exists (select 1 from public.transactions where source_pending_id=suspected_id)
  or (select count(*) from public.audit_logs where entity_id=suspected_id and action like 'duplicate_%')<>4
 then raise exception 'DUPLICATE_DISMISSAL_CHANGED_LEDGER'; end if;

 perform set_config('request.jwt.claim.sub','77777777-0000-4000-8000-000000000002',true);
 begin
  perform public.list_pending_duplicate_candidates(suspected_id);
  raise exception 'EXPECTED_OTHER_USER_READ_REJECTION';
 exception when no_data_found then
  if sqlerrm <> 'PENDING_NOT_FOUND' then raise; end if;
 end;
 begin
  perform public.review_pending_duplicate(suspected_id,5,'keep');
  raise exception 'EXPECTED_OTHER_USER_WRITE_REJECTION';
 exception when no_data_found then
  if sqlerrm <> 'PENDING_NOT_FOUND' then raise; end if;
 end;
end
$$;
set constraints all immediate;
rollback;
