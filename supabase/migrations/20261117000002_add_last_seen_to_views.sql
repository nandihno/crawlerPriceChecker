-- Include p.last_seen_at in v_latest_prices and v_current_specials so consumers can see
-- both when a price last changed (scraped_at) and when the product was last checked (last_seen_at).

CREATE OR REPLACE VIEW public.v_latest_prices
WITH (security_invoker = true) AS
SELECT DISTINCT ON (p.id)
    p.id AS product_id,
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
FROM public.products p
JOIN public.price_history ph ON ph.product_id = p.id
ORDER BY p.id, ph.scraped_at DESC;

CREATE OR REPLACE VIEW public.v_current_specials
WITH (security_invoker = true) AS
SELECT *
FROM public.v_latest_prices
WHERE is_on_special = true
   OR is_half_price = true
   OR promotion IS NOT NULL
   OR (was_price IS NOT NULL AND price IS NOT NULL AND was_price > price)
ORDER BY discount_pct DESC NULLS LAST, savings_amount DESC NULLS LAST;
