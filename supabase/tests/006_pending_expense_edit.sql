begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','66666666-eeee-4eee-8eee-eeeeeeeeeeee',true);

do $$
declare
 owner_id uuid := auth.uid();
 purchase_at constant timestamptz := '2026-11-25T08:35:18.123456+09:00';
 pay uuid;
 expense uuid;
 category uuid;
 event_id uuid;
 draft_id uuid;
 tx_id uuid;
 result jsonb;
 original jsonb;
begin
 insert into public.financial_accounts(user_id,name,kind)
 values(owner_id,'Edit test asset','asset') returning id into pay;
 insert into public.financial_accounts(user_id,name,kind)
 values(owner_id,'Edit test expense','expense') returning id into expense;
 insert into public.categories(user_id,name,expense_account_id)
 values(owner_id,'Edit test category',expense) returning id into category;
 event_id := public.record_notification_event('edit-legacy-event','com.example.edit',purchase_at,'{}');
 draft_id := public.create_pending_expense('Original shop',5500,purchase_at,'debit_card',pay,category,event_id);

 result := public.edit_pending_expense(draft_id,1,'Original shop','5500',purchase_at,'debit_card',pay,category);
 if result->>'version' is distinct from '1'
  or exists (select 1 from public.audit_logs where entity_id=draft_id and action='edit')
 then raise exception 'NOOP_CHANGED_DRAFT'; end if;

 perform set_config('request.jwt.claim.sub','77777777-eeee-4eee-8eee-eeeeeeeeeeee',true);
 begin
  perform public.edit_pending_expense(draft_id,1,'Other shop','6500',purchase_at,'debit_card',pay,category);
  raise exception 'EXPECTED_CROSS_USER_EDIT_REJECTION';
 exception when no_data_found then
  if sqlerrm <> 'PENDING_NOT_FOUND' then raise; end if;
 end;
 perform set_config('request.jwt.claim.sub',owner_id::text,true);

 begin
  perform public.edit_pending_expense(draft_id,1,'Wrong account','6500',purchase_at,'debit_card',expense,category);
  raise exception 'EXPECTED_ACCOUNT_REJECTION';
 exception when invalid_parameter_value then
  if sqlerrm <> 'ACCOUNT_CATEGORY_MISMATCH' then raise; end if;
 end;

 result := public.edit_pending_expense(draft_id,1,'Corrected shop','9007199254740993',purchase_at,'debit_card',pay,category);
 if result->>'version' is distinct from '2' or exists (select 1 from public.transactions where source_pending_id=draft_id)
  or not exists (select 1 from public.audit_logs where entity_id=draft_id and action='edit'
   and details->'before'->>'amount_minor'='5500' and details->'after'->>'amount_minor'='9007199254740993')
 then raise exception 'EDIT_AUDIT_OR_VERSION_INVALID'; end if;

 original := jsonb_build_object('status','parsed','merchant','Original shop','amount_minor',5500,
  'occurred_at','2026-11-25T08:35:18.123456+09:00','payment_method','debit_card','payment_account_id',pay,'category_id',category);
 result := public.ingest_notification_event('edit-legacy-event','com.example.edit',purchase_at,original);
 if result->>'pending_transaction_id' is distinct from draft_id::text
  or not exists (select 1 from public.pending_transactions where id=draft_id and merchant='Corrected shop'
   and amount_minor=9007199254740993 and occurred_at=purchase_at and version=2)
 then raise exception 'ORIGINAL_DELIVERY_REPLACED_EDIT'; end if;

 begin
  perform public.approve_pending_expense(draft_id,1,gen_random_uuid());
  raise exception 'EXPECTED_STALE_APPROVAL_REJECTION';
 exception when raise_exception then
  if sqlerrm <> 'STALE_OR_NOT_REVIEWABLE' then raise; end if;
 end;
 result := public.approve_pending_expense(draft_id,2,gen_random_uuid());
 tx_id := (result->>'transaction_id')::uuid;
 if (select count(*) from public.ledger_entries where transaction_id=tx_id and amount_minor=9007199254740993)<>2
 then raise exception 'APPROVAL_DID_NOT_POST_UPDATED_AMOUNT'; end if;

 begin
  perform public.edit_pending_expense(draft_id,3,'Confirmed edit','6000',purchase_at,'debit_card',pay,category);
  raise exception 'EXPECTED_CONFIRMED_EDIT_REJECTION';
 exception when raise_exception then
  if sqlerrm <> 'STALE_OR_NOT_REVIEWABLE' then raise; end if;
 end;
end
$$;
set constraints all immediate;
rollback;
