\set ON_ERROR_STOP on
begin;

insert into public.scrape_runs (id, apify_run_id)
values ('10000000-0000-0000-0000-000000000000', 'ranked-search-test');

insert into public.products (stockcode, name) values
  (1, 'Milk'),
  (2, 'Oat Milk 1L'),
  (3, 'Oat Long Life Milk'),
  (4, 'Milk Chocolate'),
  (5, 'Milkshake'),
  (6, 'Orange Juice'),
  (7, 'Milk 100% Pure'),
  (8, 'A+ Blend'),
  (9, 'Oat Drink'),
  (10, 'Milk And Oat'),
  (11, 'Milk without a price'),
  (12, 'Millk');

insert into public.price_history (product_id, run_id, stockcode, price, scraped_at)
select id, '10000000-0000-0000-0000-000000000000', stockcode, 2.00, now()
from public.products where stockcode <> 11;

set local role anon;

do $$
declare
  matches text[];
  expected text[];
  first_page text[];
  second_page text[];
begin
  select array_agg(name order by ordinality) into matches
  from public.search_products('milk', 50, 0) with ordinality;

  if matches is null or matches[1] <> 'Milk'
    or array_position(matches, 'Milkshake') <= array_position(matches, 'Milk Chocolate')
    or not array['Milk', 'Oat Milk 1L', 'Oat Long Life Milk', 'Milk Chocolate', 'Milkshake',
      'Milk 100% Pure', 'Milk And Oat'] <@ matches
    or 'Orange Juice' = any(matches)
    or 'Milk without a price' = any(matches) then
    raise exception 'Unexpected milk matches: %', matches;
  end if;

  select array_agg(name order by ordinality) into matches
  from public.search_products('oat milk', 50, 0) with ordinality;
  if matches is null or matches[1] <> 'Oat Milk 1L'
    or not array['Oat Long Life Milk', 'Milk And Oat'] <@ matches
    or array_position(matches, 'Milk And Oat') >= array_position(matches, 'Oat Long Life Milk')
    or 'Oat Drink' = any(matches) then
    raise exception 'Unexpected oat milk matches: %', matches;
  end if;

  select array_agg(name order by ordinality) into matches
  from public.search_products('milkk', 50, 0) with ordinality;
  if matches is null or not 'Milk' = any(matches) or 'Orange Juice' = any(matches) then
    raise exception 'Unexpected milkk matches: %', matches;
  end if;

  if not exists (select from public.search_products('oat milkk', 50, 0) where name = 'Oat Milk 1L')
    or exists (select from public.search_products('oat milkk', 50, 0) where name = 'Milk Chocolate') then
    raise exception 'Multi-word typo matching failed';
  end if;

  if (select array_agg(name) from public.search_products('%', 50, 0)) is distinct from array['Milk 100% Pure']
    or (select name from public.search_products('A+ Blend', 1, 0)) is distinct from 'A+ Blend'
    or exists (select from public.search_products('  ', 50, 0))
    or exists (select from public.search_products('zzqxx', 50, 0)) then
    raise exception 'Literal, empty or unrelated searches failed';
  end if;

  select array_agg(name order by ordinality) into expected
  from public.search_products('milk', 50, 0) with ordinality;
  select array_agg(name order by ordinality) into first_page
  from public.search_products('milk', 2, 0) with ordinality;
  select array_agg(name order by ordinality) into second_page
  from public.search_products('milk', 50, 2) with ordinality;
  if first_page || second_page is distinct from expected then
    raise exception 'Pagination changed the result order';
  end if;
end;
$$;

reset role;
set local role authenticated;
select 1 / (exists(select from public.search_products('milk', 1, 0) where price = 2))::integer
  as authenticated_search;

rollback;
