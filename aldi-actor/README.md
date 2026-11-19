# ALDI AU Prices (`aldi-au-prices`)

Apify actor for scraping ALDI Australia (`aldi.com.au`) product prices, unit prices, and specials.

Outputs the exact same normalized 24-field dataset schema as `woolworths-au-prices` (with `chain: "aldi"` and positive integer `stockcode`), so runs can be ingested directly by the existing `supabase/functions/ingest-apify-run` Edge Function without any database schema changes.

## Deploy to Apify

From this directory:

```bash
cd aldi-actor
apify push
```

## Local Tests

```bash
cd aldi-actor
npm test
```

## Input

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `searchTerms` | `string[]` | `["milk"]` | Keywords to search on `aldi.com.au` |
| `skus` | `string[]` | `[]` | Specific ALDI product SKUs to fetch directly |
| `maxItemsPerSearch` | `integer` | `36` | Max products per search term |
| `serviceType` | `string` | `"walk-in"` | ALDI API `serviceType` (`walk-in`, `pickup`, `delivery`) |
| `region` | `string` | `"au"` | Region tag stored on each dataset item |
| `delayMs` | `integer` | `1200` | Delay in ms between API requests |
| `proxyConfiguration` | `object` | `RESIDENTIAL` (`AU`) | Apify proxy configuration |
