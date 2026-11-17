# Woolworths AU Prices (v0.1)

Gets prices, specials and unit prices from woolworths.com.au by calling the site's own JSON search API (`POST /apis/ui/Search/products`) from inside a real browser session.

## Deploy

```bash
npm i -g apify-cli
apify login
apify push          # builds on Apify using the Dockerfile
```

Local run: `npm install && npx playwright install chromium && apify run`

## Input example

```json
{
  "searchTerms": ["full cream milk 2l", "tim tam"],
  "stockcodes": ["888137"],
  "maxItemsPerSearch": 72,
  "specialsOnly": false,
  "proxyConfiguration": { "useApifyProxy": true }
}
```

Defaults to Residential AU proxies. The run fails (non-zero exit) if no products are collected. Equivalent proxy input: `{"useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"], "apifyProxyCountry": "AU"}`.

## Output row

`chain, stockcode, barcode, name, brand, packageSize, price, wasPrice, savingsAmount, isOnSpecial, isHalfPrice, promotion, isMultibuy, departments, category, productLimit, cupPrice, cupMeasure, cupString, isAvailable, url, imageUrl, source, scrapedAt`

## Verify on first run

1. Response shape: field names come from community notes and are not guaranteed. Check a few rows.
2. `/apis/ui/product/detail/{stockcode}` (watchlist) is unverified. Confirm it in DevTools.
3. Store: prices are for the site's default store (chosen by Woolworths from the proxy IP; `region` records it, e.g. `syd2`). Woolworths requires a login to choose a store, so this is a deliberate limitation.

## Roadmap

- v0.2: category crawl (`/shop/browse/...`), push results to a Supabase `price_history` table
- v0.3: plain-HTTP fast path (got-scraping), with the browser only as a fallback

## Supabase Integration & Deployment

The Supabase schema migrations, Edge Function, and configuration live inside `supabase/` in this project:

- `supabase/config.toml` — Supabase project config (`wntllezsoavodlrpqcue`)
- `supabase/migrations/20261117000001_create_grocery_schema.sql` — Tables (`scrape_runs`, `products`, `price_history`), views (`v_latest_prices`, `v_current_specials`), indexes, and RLS policies
- `supabase/functions/ingest-apify-run/index.ts` — Edge Function triggered by the Apify `ACTOR.RUN.SUCCEEDED` webhook to fetch, deduplicate, and upsert dataset items

### Deploy from `woolworths-actor/`

```bash
# First-time setup
npm run supabase:login
npm run supabase:link

# If running db:push for the first time, mark the initial migration as already applied:
npx supabase migration repair --status applied 20261117000001

# Deploy database migrations and/or Edge Function
npm run supabase:db:push
npm run supabase:functions:deploy
npm run supabase:deploy
```

#### When to run each command

- **Changed the Edge Function** (`supabase/functions/ingest-apify-run/index.ts`): `npm run supabase:functions:deploy`
- **Added a new database migration** (`supabase/migrations/*.sql`): `npm run supabase:db:push`
- **Changed both migrations and the Edge Function**: `npm run supabase:deploy`
- **Changed the Woolworths scraper itself** (`src/main.js`): `apify push`

### Manually backfill an Apify run

```bash
curl -X POST "https://wntllezsoavodlrpqcue.supabase.co/functions/v1/ingest-apify-run" \
  -H "Content-Type: application/json" \
  -H "x-apify-token: <YOUR_APIFY_API_TOKEN>" \
  -d '{"runId": "<APIFY_RUN_ID>"}'
```
