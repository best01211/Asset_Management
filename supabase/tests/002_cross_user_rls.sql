-- Cross-user read isolation. Run against isolated LOCAL Supabase DB only.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
select set_config('request.jwt.claim.role','authenticated',true);
insert into public.financial_accounts(user_id,name,kind) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','User B account','asset');
select set_config('request.jwt.claim.sub','cccccccc-cccc-4ccc-8ccc-cccccccccccc',true);
do $$ begin
 if exists(select 1 from public.financial_accounts where user_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
 then raise exception 'RLS_LEAK'; end if;
 raise notice 'PASS: user C cannot see B accounts';
end $$;
rollback;
