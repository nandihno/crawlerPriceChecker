# Coles AU Prices (`coles-au-prices`)

Apify actor for scraping Coles Australia (`coles.com.au`) product prices, unit prices, and specials.

Outputs the exact same normalized 24-field dataset schema as `woolworths-au-prices` and `aldi-au-prices` (with `chain: "coles"` and positive integer `stockcode`), so runs can be ingested directly by the existing `supabase/functions/ingest-apify-run` Edge Function.

## Deploy to Apify

```bash
cd coles-actor
apify push
```

## Local Tests

```bash
cd coles-actor
npm test
```

## Recommended Run Settings
- **Proxy**: `RESIDENTIAL` (`AU`) — required to pass Imperva/Incapsula WAF
- **Memory**: `1024 MB`
- **Schedule**: Weekly on **Wednesday morning** (AEST/AEDT) right after weekly catalogue specials roll over
