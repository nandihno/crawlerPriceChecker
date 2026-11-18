-- Run only against an isolated, disposable database after the migration.
\set ON_ERROR_STOP on
begin;
insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');
insert into public.products (id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
insert into public.user_favourites (product_id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
insert into public.user_favourites (product_id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  on conflict (user_id, product_id) do nothing;
do $$
begin
  if (select count(*) from public.user_favourites) <> 1 then
    raise exception 'User A cannot read their favourite';
  end if;
  begin
    insert into public.user_favourites (user_id, product_id)
    values ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    raise exception 'User A was able to write for User B';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.user_favourites set user_id = '22222222-2222-2222-2222-222222222222';
    raise exception 'User A was able to update favourites';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
do $$
begin
  if (select count(*) from public.user_favourites) <> 0 then
    raise exception 'User B can read User A favourites';
  end if;
  delete from public.user_favourites where user_id = '11111111-1111-1111-1111-111111111111';
  if found then raise exception 'User B can delete User A favourites'; end if;
end $$;
insert into public.user_favourites (product_id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
reset role;
set local role anon;
do $$
begin
  if has_table_privilege(current_user, 'public.user_favourites', 'SELECT')
     or has_table_privilege(current_user, 'public.user_favourites', 'INSERT')
     or has_table_privilege(current_user, 'public.user_favourites', 'DELETE') then
    raise exception 'Anonymous access was granted';
  end if;
end $$;
reset role;
delete from auth.users where id = '11111111-1111-1111-1111-111111111111';
do $$
begin
  if exists (select 1 from public.user_favourites where user_id = '11111111-1111-1111-1111-111111111111') then
    raise exception 'User deletion did not remove their favourites';
  end if;
  if (select count(*) from public.user_favourites) <> 1 then
    raise exception 'User deletion affected another user';
  end if;
  if (select count(*) from public.products) <> 1 then
    raise exception 'User deletion removed the product';
  end if;
end $$;
rollback;
