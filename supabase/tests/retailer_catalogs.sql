\set ON_ERROR_STOP on
begin;

insert into public.scrape_runs (id, apify_run_id, chain) values
  ('20000000-0000-0000-0000-000000000001', 'retailer-catalog-test-woolworths', 'woolworths'),
  ('20000000-0000-0000-0000-000000000002', 'retailer-catalog-test-aldi', 'aldi');

insert into public.products (chain, stockcode, name) values
  ('woolworths', 101, 'Milk'),
  ('aldi', 101, 'Full Cream Milk'),
  ('aldi', 102, 'Milk Powder');

insert into public.price_history (product_id, run_id, chain, stockcode, price, scraped_at)
select p.id, r.id, p.chain, p.stockcode, 2.50, now()
from public.products p
join public.scrape_runs r on r.chain = p.chain
where r.apify_run_id in ('retailer-catalog-test-woolworths', 'retailer-catalog-test-aldi');

set local role anon;
select 1 / (array(select chain from public.retailers order by chain) = array['woolworths'])::integer
  as disabled_retailer_hidden;
select 1 / (not exists (select from public.search_products_by_chain('aldi', 'milk', 1, 0)))::integer
  as disabled_retailer_search_hidden;
select 1 / (not has_table_privilege(current_user, 'public.retailers', 'UPDATE'))::integer
  as anonymous_registry_read_only;

reset role;
update public.retailers set enabled = true where chain = 'aldi';

set local role anon;
select 1 / (array(select chain from public.retailers order by chain) = array['aldi', 'woolworths'])::integer
  as enabled_retailers_visible;
select 1 / (
  array(select chain from public.search_products_by_chain('aldi', 'milk', 1, 0)) = array['aldi']
  and array(select chain from public.search_products_by_chain('aldi', 'milk', 1, 1)) = array['aldi']
  and not exists (select from public.search_products_by_chain('aldi', 'milk', 1, 2))
)::integer as chain_filtered_before_pagination;
select 1 / (array(select chain from public.search_products('milk', 50, 0)) = array['woolworths'])::integer
  as legacy_search_remains_woolworths;

reset role;
set local role authenticated;
select 1 / (array(select chain from public.search_products_by_chain('aldi', 'milk', 1, 0)) = array['aldi'])::integer
  as authenticated_retailer_search;
select 1 / (not has_table_privilege(current_user, 'public.retailers', 'INSERT'))::integer
  as authenticated_registry_read_only;

rollback;
