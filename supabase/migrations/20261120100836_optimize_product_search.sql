-- Optimize public.search_products_by_chain by scoring and paginating public.products
-- before joining the latest price_history snapshot, adding supporting indexes,
-- and adding a multi-word prefix matching tier for live type-ahead queries.

create index if not exists idx_products_name_simple
  on public.products using gin (to_tsvector('simple', name));

create index if not exists idx_products_name_trgm
  on public.products using gin (lower(name) extensions.gin_trgm_ops);

create index if not exists idx_products_chain_lower_name
  on public.products (chain, lower(name), id);

create or replace function public.search_products_by_chain(
  retailer_chain text, search_text text, page_size integer, page_offset integer
)
returns setof public.v_latest_prices
language sql
stable
security invoker
set search_path = ''
as $$
  with raw_query as materialized (
    select
      lower(btrim(search_text)) as input,
      length(to_tsvector('english', search_text)) > 0 as has_keywords
  ),
  all_tokens as materialized (
    select distinct
      word[1] as token
    from raw_query
    cross join lateral regexp_matches(raw_query.input, '[[:alnum:]]+', 'g') as word
  ),
  query_words as materialized (
    select
      token as spelling,
      plainto_tsquery('english', token) as keyword
    from all_tokens
    where length(to_tsvector('english', token)) > 0
  ),
  query as materialized (
    select
      raw_query.input,
      case when raw_query.has_keywords then phraseto_tsquery('english', search_text) end as phrase,
      case when raw_query.has_keywords then plainto_tsquery('english', search_text) end as keywords,
      (
        select to_tsquery('english', string_agg(spelling || ':*', ' & '))
        from query_words
      ) as prefix_keywords,
      (
        select to_tsquery('simple', string_agg(token || ':*', ' & '))
        from all_tokens
        where length(to_tsvector('english', token)) > 0
      ) as prefix_simple,
      exists (select 1 from query_words) as has_query_words
    from raw_query
  ),
  titles as (
    select
      p.id as product_id,
      p.name as raw_name,
      to_tsvector('english', p.name) as title,
      to_tsvector('simple', p.name) as simple_title,
      lower(p.name) as name,
      query.*
    from public.products as p
    cross join query
    where p.chain = retailer_chain
      and query.input <> ''
      and exists (
        select 1 from public.retailers
        where chain = retailer_chain and enabled
      )
      and exists (
        select 1 from public.price_history as ph
        where ph.product_id = p.id
      )
  ),
  direct_matches as (
    select *,
      case
        when name = input then 1
        when title @@ phrase then 2
        when title @@ keywords then 3
        when strpos(name, input) > 0 then 4
        when (prefix_keywords is not null and title @@ prefix_keywords)
          or (prefix_simple is not null and simple_title @@ prefix_simple) then 5
      end as match_tier
    from titles
  ),
  scored as (
    select *,
      case when match_tier is null and has_query_words then (
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
  ),
  paginated as materialized (
    select
      product_id,
      match_tier,
      case
        when match_tier = 3 then ts_rank_cd(title, keywords)
        when match_tier = 5 then greatest(
          coalesce(case when prefix_keywords is not null then ts_rank_cd(title, prefix_keywords) end, 0),
          coalesce(case when prefix_simple is not null then ts_rank_cd(simple_title, prefix_simple) end, 0)
        )
      end as text_rank,
      typo_score,
      raw_name
    from scored
    where match_tier is not null or typo_score >= 0.55
    order by
      match_tier nulls last,
      text_rank desc nulls last,
      typo_score desc nulls last,
      raw_name,
      product_id
    limit greatest(1, least(coalesce(page_size, 50), 100))
    offset greatest(0, coalesce(page_offset, 0))
  )
  select
    p.id as product_id,
    p.chain,
    p.stockcode,
    p.barcode,
    p.name,
    p.brand,
    p.package_size,
    ph.price,
    ph.was_price,
    ph.savings_amount,
    ph.discount_pct,
    ph.is_on_special,
    ph.is_half_price,
    ph.promotion,
    ph.is_multibuy,
    ph.cup_price,
    ph.cup_measure,
    ph.cup_string,
    ph.is_available,
    p.departments,
    p.category,
    ph.source,
    ph.region,
    ph.scraped_at,
    p.url,
    p.image_url,
    ph.run_id,
    p.last_seen_at
  from paginated
  join public.products as p on p.id = paginated.product_id
  cross join lateral (
    select *
    from public.price_history as ph
    where ph.product_id = p.id
    order by ph.scraped_at desc
    limit 1
  ) as ph
  order by
    paginated.match_tier nulls last,
    paginated.text_rank desc nulls last,
    paginated.typo_score desc nulls last,
    paginated.raw_name,
    paginated.product_id;
$$;

revoke execute on function public.search_products_by_chain(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.search_products_by_chain(text, text, integer, integer)
  to anon, authenticated;
