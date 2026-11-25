create function public.edit_pending_expense(
 p_pending_id uuid,p_expected_version integer,p_merchant text,p_amount_minor text,p_occurred_at timestamptz,
 p_payment_method text,p_payment_account_id uuid,p_category_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
 uid uuid := auth.uid();
 draft public.pending_transactions%rowtype;
 merchant_name text := trim(p_merchant);
 parsed_amount bigint;
 next_version integer;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_pending_id is null or p_expected_version is null or p_expected_version<1
  or merchant_name is null or length(merchant_name) not between 1 and 200
  or p_amount_minor is null or p_amount_minor !~ '^[1-9][0-9]{0,18}$'
  or p_occurred_at is null or not isfinite(p_occurred_at)
  or p_payment_method is null or p_payment_method not in ('credit_card','debit_card','cash')
  or p_payment_account_id is null or p_category_id is null then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;
 parsed_amount := p_amount_minor::bigint;

 select * into draft from public.pending_transactions
 where user_id=uid and id=p_pending_id for update;
 if not found then raise exception 'PENDING_NOT_FOUND' using errcode='P0002'; end if;
 if draft.status<>'pending_review' or draft.version<>p_expected_version then
  raise exception 'STALE_OR_NOT_REVIEWABLE' using errcode='P0001';
 end if;

 -- The original approval locks this same draft. Keep the payment account active through the edit.
 perform 1 from public.financial_accounts pay
 join public.categories cat on cat.user_id=pay.user_id and cat.id=p_category_id
 join public.financial_accounts expense on expense.user_id=cat.user_id and expense.id=cat.expense_account_id
 where pay.user_id=uid and pay.id=p_payment_account_id and pay.active
  and draft.currency='KRW' and pay.currency=draft.currency
  and expense.kind='expense' and expense.currency=draft.currency
  and pay.kind=case when p_payment_method='credit_card' then 'liability' else 'asset' end
 for share of pay;
 if not found then raise exception 'ACCOUNT_CATEGORY_MISMATCH' using errcode='22023'; end if;

 if (draft.merchant,draft.amount_minor,draft.occurred_at,draft.payment_method,draft.payment_account_id,draft.category_id)
    is not distinct from (merchant_name,parsed_amount,p_occurred_at,p_payment_method,p_payment_account_id,p_category_id) then
  return jsonb_build_object('pending_transaction_id',draft.id,'status',draft.status,'version',draft.version);
 end if;

 -- Preserve the originally submitted candidate of legacy events before a manual edit.
 if draft.notification_event_id is not null then
  update public.notification_events set ingestion_candidate_hash=sha256(convert_to(jsonb_build_array(
   draft.merchant,draft.amount_minor,extract(epoch from draft.occurred_at),
   draft.payment_method,draft.payment_account_id,draft.category_id
  )::text,'UTF8'))
  where user_id=uid and id=draft.notification_event_id and ingestion_candidate_hash is null;
 end if;

 update public.pending_transactions
 set merchant=merchant_name,amount_minor=parsed_amount,occurred_at=p_occurred_at,payment_method=p_payment_method,
  payment_account_id=p_payment_account_id,category_id=p_category_id,version=version+1,updated_at=now()
 where user_id=uid and id=draft.id returning version into next_version;

 insert into public.audit_logs(user_id,entity_type,entity_id,action,details)
 values(uid,'pending_transaction',draft.id,'edit',jsonb_build_object(
  'before',jsonb_build_object('version',draft.version,'merchant',draft.merchant,'amount_minor',draft.amount_minor::text,
   'occurred_at',draft.occurred_at,'payment_method',draft.payment_method,'payment_account_id',draft.payment_account_id,'category_id',draft.category_id),
  'after',jsonb_build_object('version',next_version,'merchant',merchant_name,'amount_minor',p_amount_minor,
   'occurred_at',p_occurred_at,'payment_method',p_payment_method,'payment_account_id',p_payment_account_id,'category_id',p_category_id)));
 return jsonb_build_object('pending_transaction_id',draft.id,'status',draft.status,'version',next_version);
end;
$$;

revoke all on function public.edit_pending_expense(uuid,integer,text,text,timestamptz,text,uuid,uuid) from public,anon;
grant execute on function public.edit_pending_expense(uuid,integer,text,text,timestamptz,text,uuid,uuid) to authenticated;
