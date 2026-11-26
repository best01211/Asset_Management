create index transactions_owner_date_id_idx on public.transactions(user_id,occurred_at desc,id desc)
 where kind<>'opening_balance';

create table public.transaction_annotations (
 user_id uuid not null,
 transaction_id uuid not null,
 memo text not null default '' check (length(memo)<=1000),
 tags text[] not null default '{}' check (cardinality(tags)<=10),
 version integer not null check (version>0),
 primary key (user_id,transaction_id),
 foreign key (user_id,transaction_id) references public.transactions(user_id,id)
);
alter table public.transaction_annotations enable row level security;
revoke all on public.transaction_annotations from public,anon,authenticated;
grant select on public.transaction_annotations to authenticated;
create policy transaction_annotations_owner_read on public.transaction_annotations
 for select to authenticated using (user_id=(select auth.uid()));

create schema if not exists private;
grant usage on schema private to authenticated;

create function private.save_transaction_annotation(p_id uuid,p_version integer,p_memo text,p_tags text[]) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 uid uuid := auth.uid();
 current_annotation public.transaction_annotations%rowtype;
 saved public.transaction_annotations%rowtype;
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 if p_version is null or p_version<0 or p_version>=2147483647 or p_memo is null or length(p_memo)>1000 or p_tags is null
  or cardinality(p_tags)>10 or coalesce(array_ndims(p_tags),1)<>1
  or exists(select 1 from unnest(p_tags) as tag where tag is null or tag<>trim(tag) or length(tag) not between 1 and 24)
  then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 perform 1 from public.transactions where user_id=uid and id=p_id for update;
 if not found then raise exception 'TRANSACTION_NOT_FOUND' using errcode='P0002'; end if;
 select * into current_annotation from public.transaction_annotations where user_id=uid and transaction_id=p_id;
 if coalesce(current_annotation.version,0)<>p_version then
  raise exception 'STALE_ANNOTATION' using errcode='23505';
 end if;
 if current_annotation.memo=p_memo and current_annotation.tags=p_tags then
  return jsonb_build_object('memo',current_annotation.memo,'tags',current_annotation.tags,'version',current_annotation.version);
 end if;
 insert into public.transaction_annotations as annotation(user_id,transaction_id,memo,tags,version)
 values(uid,p_id,p_memo,p_tags,p_version+1)
 on conflict(user_id,transaction_id) do update set memo=excluded.memo,tags=excluded.tags,version=excluded.version
 returning annotation.* into saved;
 insert into public.audit_logs(user_id,entity_type,entity_id,action,details)
 values(uid,'transaction',p_id,'transaction_annotation_saved',jsonb_build_object('version',saved.version));
 return jsonb_build_object('memo',saved.memo,'tags',saved.tags,'version',saved.version);
end;
$$;

create function public.save_transaction_annotation(p_id uuid,p_version integer,p_memo text,p_tags text[]) returns jsonb
language sql set search_path='' as $$
 select private.save_transaction_annotation(p_id,p_version,p_memo,p_tags)
$$;
revoke all on function private.save_transaction_annotation(uuid,integer,text,text[]),
 public.save_transaction_annotation(uuid,integer,text,text[]) from public,anon,authenticated;
grant execute on function private.save_transaction_annotation(uuid,integer,text,text[]),
 public.save_transaction_annotation(uuid,integer,text,text[]) to authenticated;
