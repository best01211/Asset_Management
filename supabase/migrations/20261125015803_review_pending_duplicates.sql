alter table public.pending_transactions
 add column duplicate_of_pending_id uuid,
 add constraint pending_duplicate_same_owner_fk foreign key (user_id,duplicate_of_pending_id)
  references public.pending_transactions(user_id,id),
 add constraint pending_duplicate_reference_valid check (
  duplicate_of_pending_id is null
  or (duplicate_of_pending_id<>id and status in ('duplicate_suspected','dismissed')));

create index pending_duplicate_reference_idx on public.pending_transactions(user_id,duplicate_of_pending_id)
 where duplicate_of_pending_id is not null;
create index pending_duplicate_search_idx on public.pending_transactions(user_id,currency,amount_minor,occurred_at);

create function public.list_pending_duplicate_candidates(p_pending_id uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
 uid uuid := auth.uid();
 draft public.pending_transactions%rowtype;
 candidates jsonb;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 select * into draft from public.pending_transactions where user_id=uid and id=p_pending_id;
 if not found then raise exception 'PENDING_NOT_FOUND' using errcode='P0002'; end if;
 select coalesce(jsonb_agg(to_jsonb(c) order by c.linked desc,c.same_merchant desc,c.seconds_apart,c.id),'[]'::jsonb)
 into candidates
 from (
  select p.id,p.merchant,p.amount_minor::text,p.currency,p.occurred_at,p.status,
   p.id is not distinct from draft.duplicate_of_pending_id as linked,
   lower(trim(p.merchant))=lower(trim(draft.merchant)) as same_merchant,
   case when isfinite(p.occurred_at) and isfinite(draft.occurred_at)
     then abs(extract(epoch from (p.occurred_at-draft.occurred_at))) end as seconds_apart
  from public.pending_transactions p
  where p.user_id=uid and p.id<>draft.id and (
   p.id=draft.duplicate_of_pending_id or (
    p.status in ('pending_review','confirmed') and p.currency=draft.currency and p.amount_minor=draft.amount_minor
    and p.occurred_at between draft.occurred_at-interval '72 hours' and draft.occurred_at+interval '72 hours'
   ))
  order by linked desc,same_merchant desc,seconds_apart,p.id
  limit 20
 ) c;
 return jsonb_build_object('linked_id',draft.duplicate_of_pending_id,'candidates',candidates);
end;
$$;

create function public.review_pending_duplicate(
 p_pending_id uuid,p_expected_version integer,p_action text,p_reference_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
 uid uuid := auth.uid();
 draft public.pending_transactions%rowtype;
 reference public.pending_transactions%rowtype;
 next_status text;
 next_reference uuid;
 locked_reference uuid := p_reference_id;
 next_version integer;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_pending_id is null or coalesce(p_expected_version,0)<1
  or p_action is null or p_action not in ('flag','keep','dismiss')
  or (p_action='flag' and (p_reference_id is null or p_reference_id=p_pending_id))
  or (p_action<>'flag' and p_reference_id is not null) then
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;

 if p_action='dismiss' then
  select duplicate_of_pending_id into locked_reference
  from public.pending_transactions where user_id=uid and id=p_pending_id;
 end if;
 -- Lock a pair in consistent ID order before changing its relationship.
 perform 1 from public.pending_transactions
 where user_id=uid and id in (p_pending_id,locked_reference) order by id for update;
 select * into draft from public.pending_transactions where user_id=uid and id=p_pending_id;
 if not found then raise exception 'PENDING_NOT_FOUND' using errcode='P0002'; end if;
 if draft.version<>p_expected_version or
  not ((p_action='flag' and draft.status in ('pending_review','duplicate_suspected'))
   or (p_action in ('keep','dismiss') and draft.status='duplicate_suspected')) then
  raise exception 'STALE_OR_NOT_REVIEWABLE' using errcode='P0001';
 end if;

 if p_action='flag' then
  select * into reference from public.pending_transactions where user_id=uid and id=p_reference_id;
  if not found or reference.status not in ('pending_review','confirmed')
   or reference.currency<>draft.currency or reference.amount_minor<>draft.amount_minor
   or exists (
    select 1 from public.pending_transactions
    where user_id=uid and duplicate_of_pending_id=draft.id
   ) then raise exception 'DUPLICATE_REFERENCE_INVALID' using errcode='22023'; end if;
  next_status := 'duplicate_suspected';
  next_reference := reference.id;
 elsif p_action='keep' then
  next_status := 'pending_review';
 else
  select * into reference from public.pending_transactions where user_id=uid and id=locked_reference;
  if not found or draft.duplicate_of_pending_id is distinct from locked_reference
   or reference.status not in ('pending_review','confirmed')
   or reference.currency<>draft.currency or reference.amount_minor<>draft.amount_minor then
   raise exception 'DUPLICATE_REFERENCE_INVALID' using errcode='22023';
  end if;
  next_status := 'dismissed';
  next_reference := draft.duplicate_of_pending_id;
 end if;

 if (draft.status,draft.duplicate_of_pending_id) is not distinct from (next_status,next_reference) then
  return jsonb_build_object('status',draft.status,'version',draft.version);
 end if;
 update public.pending_transactions
 set status=next_status,duplicate_of_pending_id=next_reference,version=version+1,updated_at=now()
 where user_id=uid and id=draft.id returning version into next_version;

 insert into public.audit_logs(user_id,entity_type,entity_id,action,details)
 values(uid,'pending_transaction',draft.id,'duplicate_' || p_action,jsonb_build_object(
  'previous_status',draft.status,'status',next_status,'previous_reference_id',draft.duplicate_of_pending_id,
  'reference_id',next_reference,'version',next_version));
 return jsonb_build_object('status',next_status,'version',next_version);
end;
$$;

revoke all on function public.list_pending_duplicate_candidates(uuid) from public,anon;
revoke all on function public.review_pending_duplicate(uuid,integer,text,uuid) from public,anon;
grant execute on function public.list_pending_duplicate_candidates(uuid) to authenticated;
grant execute on function public.review_pending_duplicate(uuid,integer,text,uuid) to authenticated;
