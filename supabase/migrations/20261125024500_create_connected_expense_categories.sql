-- These functions run with the caller's existing RLS and INSERT privileges.
create function public.create_krw_expense_category(p_name text) returns uuid
language plpgsql set search_path = '' as $$
declare
 uid uuid := auth.uid();
 requested_name text := trim(p_name);
 expense_id uuid;
 category_id uuid;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if requested_name is null or length(requested_name) not between 1 and 80 then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('category:' || uid::text || ':' || lower(requested_name),0));
 select c.id into category_id from public.categories c
 join public.financial_accounts a on a.user_id=c.user_id and a.id=c.expense_account_id
 where c.user_id=uid and lower(c.name)=lower(requested_name) and a.currency='KRW' and a.kind='expense'
 order by c.created_at,c.id limit 1;
 if found then return category_id; end if;

 insert into public.financial_accounts(user_id,name,kind,currency)
 values(uid,requested_name,'expense','KRW') returning id into expense_id;
 insert into public.categories(user_id,name,expense_account_id)
 values(uid,requested_name,expense_id) returning id into category_id;
 return category_id;
end;
$$;

create function public.create_krw_payment_account(p_name text,p_kind text) returns uuid
language plpgsql set search_path = '' as $$
declare
 uid uuid := auth.uid();
 requested_name text := trim(p_name);
 account_id uuid;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if requested_name is null or length(requested_name) not between 1 and 100
  or p_kind is null or p_kind not in ('asset','liability') then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('payment_account:' || uid::text || ':' || p_kind || ':' || lower(requested_name),0));
 select a.id into account_id from public.financial_accounts a
 where a.user_id=uid and lower(a.name)=lower(requested_name) and a.currency='KRW' and a.kind=p_kind and a.active
 order by a.created_at,a.id limit 1;
 if found then return account_id; end if;
 insert into public.financial_accounts(user_id,name,kind,currency)
 values(uid,requested_name,p_kind,'KRW') returning id into account_id;
 return account_id;
end;
$$;

revoke all on function public.create_krw_expense_category(text) from public,anon;
revoke all on function public.create_krw_payment_account(text,text) from public,anon;
grant execute on function public.create_krw_expense_category(text) to authenticated;
grant execute on function public.create_krw_payment_account(text,text) to authenticated;

alter table public.pending_transactions
 add column manual_request_id uuid,
 add column manual_request_hash bytea,
 add constraint manual_pending_request_key unique(user_id,manual_request_id),
 add constraint manual_pending_request_consistent check (
  (manual_request_id is null and manual_request_hash is null)
  or (manual_request_id is not null and manual_request_hash is not null and notification_event_id is null));

create function public.create_manual_pending_expense(
 p_merchant text,p_amount_minor bigint,p_occurred_at timestamptz,p_payment_method text,
 p_payment_account_id uuid,p_category_id uuid,p_request_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
 uid uuid := auth.uid();
 pending_id uuid;
 prior_hash bytea;
 request_hash bytea;
 candidate_status text;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_request_id is null or p_occurred_at is null or not isfinite(p_occurred_at)
  then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 request_hash := sha256(convert_to(jsonb_build_array(trim(p_merchant),p_amount_minor,
  extract(epoch from p_occurred_at),p_payment_method,p_payment_account_id,p_category_id)::text,'UTF8'));
 perform pg_advisory_xact_lock(hashtextextended('manual_pending:' || uid::text || ':' || p_request_id::text,0));
 select id,manual_request_hash,status into pending_id,prior_hash,candidate_status from public.pending_transactions
 where user_id=uid and manual_request_id=p_request_id;
 if found then
  if prior_hash<>request_hash then raise exception 'MANUAL_REQUEST_CONFLICT' using errcode='23505'; end if;
  return jsonb_build_object('pending_transaction_id',pending_id,'status',candidate_status,'replayed',true);
 end if;
 pending_id := public.create_pending_expense(p_merchant,p_amount_minor,p_occurred_at,p_payment_method,p_payment_account_id,p_category_id);
 update public.pending_transactions set manual_request_id=p_request_id,manual_request_hash=request_hash
 where user_id=uid and id=pending_id;
 return jsonb_build_object('pending_transaction_id',pending_id,'status','pending_review','replayed',false);
end;
$$;
revoke all on function public.create_manual_pending_expense(text,bigint,timestamptz,text,uuid,uuid,uuid) from public,anon;
grant execute on function public.create_manual_pending_expense(text,bigint,timestamptz,text,uuid,uuid,uuid) to authenticated;
