-- 1. Scrape Runs log table
CREATE TABLE IF NOT EXISTS public.scrape_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    apify_run_id text UNIQUE NOT NULL,
    actor_id text,
    dataset_id text,
    chain text NOT NULL DEFAULT 'woolworths',
    status text NOT NULL DEFAULT 'SUCCEEDED',
    search_terms text[],
    items_received integer NOT NULL DEFAULT 0,
    products_upserted integer NOT NULL DEFAULT 0,
    price_records_inserted integer NOT NULL DEFAULT 0,
    started_at timestamptz,
    finished_at timestamptz,
    ingested_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Products catalog table (1 row per unique chain + stockcode)
CREATE TABLE IF NOT EXISTS public.products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chain text NOT NULL DEFAULT 'woolworths',
    stockcode bigint NOT NULL,
    barcode text,
    name text NOT NULL,
    brand text,
    package_size text,
    departments text[],
    category text,
    url text,
    image_url text,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT products_chain_stockcode_key UNIQUE (chain, stockcode)
);

-- 3. Price History time-series table
CREATE TABLE IF NOT EXISTS public.price_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    run_id uuid NOT NULL REFERENCES public.scrape_runs(id) ON DELETE CASCADE,
    chain text NOT NULL DEFAULT 'woolworths',
    stockcode bigint NOT NULL,
    price numeric(10, 2),
    was_price numeric(10, 2),
    savings_amount numeric(10, 2),
    discount_pct numeric(5, 2) GENERATED ALWAYS AS (
        CASE
            WHEN was_price IS NOT NULL AND was_price > 0 AND price IS NOT NULL AND was_price > price
            THEN ROUND(((was_price - price) / was_price) * 100, 2)
            ELSE NULL
        END
    ) STORED,
    is_on_special boolean NOT NULL DEFAULT false,
    is_half_price boolean NOT NULL DEFAULT false,
    promotion text,
    is_multibuy boolean NOT NULL DEFAULT false,
    product_limit integer,
    cup_price numeric(10, 2),
    cup_measure text,
    cup_string text,
    is_available boolean,
    source text,
    region text,
    scraped_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT price_history_run_product_key UNIQUE (run_id, product_id)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_products_chain_stockcode ON public.products(chain, stockcode);
CREATE INDEX IF NOT EXISTS idx_products_name ON public.products USING gin (to_tsvector('english', name));
CREATE INDEX IF NOT EXISTS idx_price_history_product_scraped ON public.price_history(product_id, scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_history_specials ON public.price_history(is_on_special) WHERE is_on_special = true;

-- 4. View: Latest price per product
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
    ph.run_id
FROM public.products p
JOIN public.price_history ph ON ph.product_id = p.id
ORDER BY p.id, ph.scraped_at DESC;

-- 5. View: Current specials ordered by highest discount %
CREATE OR REPLACE VIEW public.v_current_specials
WITH (security_invoker = true) AS
SELECT *
FROM public.v_latest_prices
WHERE is_on_special = true
   OR is_half_price = true
   OR promotion IS NOT NULL
   OR (was_price IS NOT NULL AND price IS NOT NULL AND was_price > price)
ORDER BY discount_pct DESC NULLS LAST, savings_amount DESC NULLS LAST;

-- 6. Enable RLS and add read policies
ALTER TABLE public.scrape_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read access to scrape_runs" ON public.scrape_runs FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Allow read access to products" ON public.products FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Allow read access to price_history" ON public.price_history FOR SELECT TO anon, authenticated USING (true);
