create table public.retailers (
  chain text primary key check (chain ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  display_name text not null check (btrim(display_name) <> ''),
  enabled boolean not null default false
);

alter table public.retailers enable row level security;

revoke all on table public.retailers from public, anon, authenticated;
grant select on table public.retailers to anon, authenticated;
create policy "Read enabled retailers"
  on public.retailers for select to anon, authenticated
  using (enabled);

insert into public.retailers (chain, display_name, enabled) values
  ('woolworths', 'Woolworths', true),
  ('aldi', 'ALDI', false);

create function public.search_products_by_chain(
  retailer_chain text, search_text text, page_size integer, page_offset integer
)
returns setof public.v_latest_prices
language sql
stable
security invoker
set search_path = ''
as $$
  with query as materialized (
    select
      lower(btrim(search_text)) as input,
      case when has_keywords then phraseto_tsquery('english', search_text) end as phrase,
      case when has_keywords then plainto_tsquery('english', search_text) end as keywords
    from (select length(to_tsvector('english', search_text)) > 0 as has_keywords) as terms
  ),
  query_words as materialized (
    select distinct
      word[1] as spelling,
      plainto_tsquery('english', word[1]) as keyword
    from query
    cross join lateral regexp_matches(query.input, '[[:alnum:]]+', 'g') as word
    where length(to_tsvector('english', word[1])) > 0
  ),
  titles as (
    select
      latest as product,
      to_tsvector('english', latest.name) as title,
      lower(latest.name) as name,
      query.*
    from public.v_latest_prices as latest
    cross join query
    where latest.chain = retailer_chain
      and query.input <> ''
      and exists (
        select 1 from public.retailers
        where chain = retailer_chain and enabled
      )
  ),
  direct_matches as (
    select *,
      case
        when name = input then 1
        when title @@ phrase then 2
        when title @@ keywords then 3
        when strpos(name, input) > 0 then 4
      end as match_tier
    from titles
  ),
  scored as (
    select *,
      case when match_tier is null then (
        -- Every searchable word must match. Only words of at least four letters
        -- qualify for fuzzy matching, so sizes and short words stay exact.
        select min(case
          when title @@ keyword then 1.0
          when spelling ~ '^[[:alpha:]]{4,}$'
            then extensions.strict_word_similarity(spelling, name)
          else 0.0
        end)
        from query_words
      ) end as typo_score
    from direct_matches
  )
  select (product).*
  from scored
  where match_tier is not null or typo_score >= 0.55
  order by
    match_tier nulls last,
    case when match_tier = 3 then ts_rank_cd(title, keywords) end desc nulls last,
    typo_score desc nulls last,
    (product).name,
    (product).product_id
  limit greatest(1, least(coalesce(page_size, 50), 100))
  offset greatest(0, coalesce(page_offset, 0));
$$;

revoke execute on function public.search_products_by_chain(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.search_products_by_chain(text, text, integer, integer)
  to anon, authenticated;

-- Keep the existing app's search contract and ranking during rollout.
create or replace function public.search_products(search_text text, page_size integer, page_offset integer)
returns setof public.v_latest_prices
language sql
stable
security invoker
set search_path = ''
as $$
  select * from public.search_products_by_chain('woolworths', search_text, page_size, page_offset);
$$;
