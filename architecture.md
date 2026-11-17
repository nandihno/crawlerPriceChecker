# Grocery Price Pipeline — Architecture & Database Schema

This document describes the end-to-end architecture, Supabase database schema, security model, and iOS integration patterns for the **Woolworths AU Prices** project.

---

## 1. High-Level Architecture & Data Flow

The pipeline runs completely serverless across **Apify** (browser-authenticated scraping) and **Supabase** (webhook ingestion, PostgreSQL storage, and REST/SDK APIs for client apps).

```mermaid
flowchart LR
    W["Woolworths AU<br/>(woolworths.com.au)"] -->|In-page fetch JSON| A["Apify Actor<br/>woolworths-au-prices<br/>(Bcm0AZdFZlaaKB9Ms)"]
    A -->|Writes items| D["Apify Dataset<br/>&amp; KV Store INPUT"]
    A -->|ACTOR.RUN.SUCCEEDED| WH["Apify Webhook<br/>(NC4Ugwda2xyB7mBff)"]
    WH -->|POST + x-apify-token| EF["Supabase Edge Function<br/>ingest-apify-run"]
    EF -->|GET run, INPUT, dataset items| AAPI["Apify API v2"]
    EF -->|Upsert catalog +<br/>change-only price history| DB[("Supabase PostgreSQL<br/>grocery-prices")]
    DB -->|PostgREST / Views<br/>(Publishable Key)| IOS["iOS App<br/>(Swift / supabase-swift)"]
```

### End-to-End Ingestion Sequence

```mermaid
sequenceDiagram
    participant Actor as Apify Actor (Playwright)
    participant Hook as Apify Webhook
    participant Edge as Edge Function (ingest-apify-run)
    participant Apify as Apify API v2
    participant PG as Supabase PostgreSQL

    Actor->>Actor: Bootstrap 1 Chrome session via AU Residential Proxy
    Actor->>Actor: Wait for Akamai _abck cookie (~0~), block images/fonts
    loop For each searchTerm & stockcode
        Actor->>Actor: page.evaluate(fetch) -> /apis/ui/Search/products
        Actor->>Actor: Normalize & push rows to Apify Dataset
    end
    Actor-->>Hook: Run finishes (ACTOR.RUN.SUCCEEDED)
    Hook->>Edge: POST /functions/v1/ingest-apify-run (run metadata)
    Edge->>Apify: GET actor-run, KVS INPUT (searchTerms), dataset items
    Edge->>Edge: Deduplicate by (chain, stockcode), merge source tags
    Edge->>PG: Upsert public.scrape_runs
    Edge->>PG: Upsert public.products (bumps last_seen_at)
    Edge->>PG: Query public.v_latest_prices for current run products
    Edge->>Edge: Filter to new products or changed prices/specials
    Edge->>PG: Upsert changed rows into public.price_history
    Edge->>PG: Update public.scrape_runs final counts
```

### Key Architectural Components

1. **Apify Actor (`woolworths-au-prices`, ID: `Bcm0AZdFZlaaKB9Ms`)**
   - Built on `apify/actor-node-playwright-chrome:20-1.59.1` using **Residential AU proxies** (`apifyProxyCountry: "AU"`).
   - Opens a single Chrome session on `https://www.woolworths.com.au`, waits for Akamai bot cookies (`_abck` containing `~0~`), and blocks static assets (`png`, `jpg`, `woff`, `mp4`, etc.) to minimize proxy bandwidth (~6.4 MB per run).
   - Calls Woolworths' internal JSON endpoints (`POST /apis/ui/Search/products` and `GET /apis/ui/product/detail/{stockcode}`) from inside the browser page context via `page.evaluate(fetch)` so requests inherit real browser cookies and TLS fingerprints.
   - Iterates over each entry in `searchTerms` sequentially within the same browser session (not combined), tagging each item's `source` (e.g., `search:Milk`).

2. **Apify Webhook (`NC4Ugwda2xyB7mBff`)**
   - Listens for `ACTOR.RUN.SUCCEEDED` on Actor `Bcm0AZdFZlaaKB9Ms`.
   - Automatically sends an HTTP `POST` to the Supabase Edge Function with the `x-apify-token` header and run/dataset metadata.

3. **Supabase Edge Function (`ingest-apify-run`)**
   - Lives at `supabase/functions/ingest-apify-run/index.ts` and deploys with `--no-verify-jwt` (`verify_jwt = false`) so Apify Webhooks and manual backfill requests can call it directly.
   - Accepts both Apify Webhook payloads (`resource` / `eventData`) and direct JSON invocations (`{"runId": "..."}` or `{"datasetId": "..."}`).
   - Deduplicates items within a run by `(chain, stockcode)`. If one product matches multiple search terms in the same run, `source` tags are merged (e.g., `"search:Spinach, search:Paneer"`) and the latest `scrapedAt` wins.
   - Implements **change-only price history**: compares incoming items against `public.v_latest_prices` and only inserts into `public.price_history` when a product is new or any of `price`, `was_price`, `is_on_special`, `is_half_price`, `promotion`, or `is_available` has changed.

---

## 2. Supabase Project & Connection Reference

| Setting | Value |
| :--- | :--- |
| **Project Name** | `grocery-prices` |
| **Project Ref / ID** | `wntllezsoavodlrpqcue` |
| **Region** | `ap-southeast-2` (Sydney) |
| **PostgreSQL Engine** | PostgreSQL 17 |
| **Supabase Project URL** | `https://wntllezsoavodlrpqcue.supabase.co` |
| **Edge Function Endpoint** | `https://wntllezsoavodlrpqcue.supabase.co/functions/v1/ingest-apify-run` |
| **Publishable Key (Recommended for iOS)** | `sb_publishable_GOqwNwuuM-X77UWa7MdXTg_4pIiU_7l` |
| **Legacy Anon JWT Key** | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndudGxsZXpzb2F2b2RscnBxY3VlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ4NTg5ODcsImV4cCI6MjExMDQzNDk4N30.g83ZZO7AYmhHNvu8eTkuP0ILNhNjUw7HRl2kyiG1GZ4` |

> **Client Key Note:** The Publishable Key (`sb_publishable_...`) is safe to embed in the iOS app bundle — Row Level Security (RLS) restricts `anon` and `authenticated` clients to **read-only (`SELECT`)** access.

---

## 3. Database Schema & Entity Relationships

```mermaid
erDiagram
    scrape_runs {
        uuid id PK
        text apify_run_id UK
        text actor_id
        text dataset_id
        text chain
        text status
        text[] search_terms
        integer items_received
        integer products_upserted
        integer price_records_inserted
        timestamptz started_at
        timestamptz finished_at
        timestamptz ingested_at
    }

    products {
        uuid id PK
        text chain
        bigint stockcode
        text barcode
        text name
        text brand
        text package_size
        text[] departments
        text category
        text url
        text image_url
        timestamptz first_seen_at
        timestamptz last_seen_at
        timestamptz updated_at
    }

    price_history {
        uuid id PK
        uuid product_id FK
        uuid run_id FK
        text chain
        bigint stockcode
        numeric price
        numeric was_price
        numeric savings_amount
        numeric discount_pct
        boolean is_on_special
        boolean is_half_price
        text promotion
        boolean is_multibuy
        integer product_limit
        numeric cup_price
        text cup_measure
        text cup_string
        boolean is_available
        text source
        text region
        timestamptz scraped_at
        timestamptz created_at
    }

    products ||--o{ price_history : "has price changes"
    scrape_runs ||--o{ price_history : "recorded during"
```

### Table: `public.scrape_runs`
Logs each Apify actor execution and ingestion summary.

| Column | Type | Nullable | Default | Constraints / Notes |
| :--- | :--- | :---: | :--- | :--- |
| `id` | `uuid` | No | `gen_random_uuid()` | Primary key |
| `apify_run_id` | `text` | No | — | `UNIQUE` (e.g., `0LlK058mqb5rzvSlX`) |
| `actor_id` | `text` | Yes | — | Apify Actor ID (`Bcm0AZdFZlaaKB9Ms`) |
| `dataset_id` | `text` | Yes | — | Apify Dataset ID |
| `chain` | `text` | No | `'woolworths'` | Store chain identifier |
| `status` | `text` | No | `'SUCCEEDED'` | Apify run status |
| `search_terms` | `text[]` | Yes | — | Search terms read from run `INPUT` |
| `items_received` | `integer` | No | `0` | Raw rows returned by Apify dataset |
| `products_upserted` | `integer` | No | `0` | Deduplicated products processed in run |
| `price_records_inserted` | `integer` | No | `0` | New/changed rows written to `price_history` |
| `started_at` | `timestamptz` | Yes | — | Run start timestamp |
| `finished_at` | `timestamptz` | Yes | — | Run finish timestamp |
| `ingested_at` | `timestamptz` | No | `now()` | Edge function ingestion timestamp |

### Table: `public.products`
Normalized product catalog containing **one row per unique `(chain, stockcode)`**.

| Column | Type | Nullable | Default | Constraints / Notes |
| :--- | :--- | :---: | :--- | :--- |
| `id` | `uuid` | No | `gen_random_uuid()` | Primary key |
| `chain` | `text` | No | `'woolworths'` | Part of `UNIQUE (chain, stockcode)` |
| `stockcode` | `bigint` | No | — | Woolworths stockcode; part of `UNIQUE (chain, stockcode)` |
| `barcode` | `text` | Yes | — | Product EAN/barcode |
| `name` | `text` | No | — | Display product name |
| `brand` | `text` | Yes | — | Product brand |
| `package_size` | `text` | Yes | — | Pack size label (e.g., `200g`, `2L`) |
| `departments` | `text[]` | Yes | — | Department list (e.g., `["Dairy, Eggs & Fridge"]`) |
| `category` | `text` | Yes | — | Optional category string |
| `url` | `text` | Yes | — | Woolworths product page URL |
| `image_url` | `text` | Yes | — | Large product image CDN URL |
| `first_seen_at` | `timestamptz` | No | `now()` | Preserved across future upserts |
| `last_seen_at` | `timestamptz` | No | `now()` | Updated on **every** run (even if price did not change) |
| `updated_at` | `timestamptz` | No | `now()` | Last catalog metadata update timestamp |

### Table: `public.price_history`
Append-mostly changelog storing **new products and price/special changes only**.

| Column | Type | Nullable | Default | Constraints / Notes |
| :--- | :--- | :---: | :--- | :--- |
| `id` | `uuid` | No | `gen_random_uuid()` | Primary key |
| `product_id` | `uuid` | No | — | `REFERENCES public.products(id) ON DELETE CASCADE`; part of `UNIQUE (run_id, product_id)` |
| `run_id` | `uuid` | No | — | `REFERENCES public.scrape_runs(id) ON DELETE CASCADE`; part of `UNIQUE (run_id, product_id)` |
| `chain` | `text` | No | `'woolworths'` | Chain identifier |
| `stockcode` | `bigint` | No | — | Product stockcode |
| `price` | `numeric(10, 2)` | Yes | — | Current shelf price (AUD) |
| `was_price` | `numeric(10, 2)` | Yes | — | Previous regular price when on special (`null` otherwise) |
| `savings_amount` | `numeric(10, 2)` | Yes | — | Dollar savings (`was_price - price`) |
| `discount_pct` | `numeric(5, 2)` | Yes | Generated | `GENERATED ALWAYS AS (ROUND(((was_price - price) / was_price) * 100, 2)) STORED` when `was_price > price` |
| `is_on_special` | `boolean` | No | `false` | Whether marked on special |
| `is_half_price` | `boolean` | No | `false` | Whether marked 50% off |
| `promotion` | `text` | Yes | — | Promo text (e.g., `"2 for $10.00 - $2.23/100G"`) |
| `is_multibuy` | `boolean` | No | `false` | Multi-buy promotion flag |
| `product_limit` | `integer` | Yes | — | Purchase limit per order |
| `cup_price` | `numeric(10, 2)` | Yes | — | Unit comparison price |
| `cup_measure` | `text` | Yes | — | Unit comparison measure (`100G`, `1KG`, `1L`) |
| `cup_string` | `text` | Yes | — | Formatted unit price (e.g., `"$1.59 / 100G"`) |
| `is_available` | `boolean` | Yes | — | Stock availability in default store region |
| `source` | `text` | Yes | — | Search/watchlist source (e.g., `"search:Spinach, search:Paneer"`) |
| `region` | `text` | Yes | — | Store region inferred from proxy IP (e.g., `syd1`, `syd2`) |
| `scraped_at` | `timestamptz` | No | — | Timestamp when this price/special state was recorded |
| `created_at` | `timestamptz` | No | `now()` | Row insertion timestamp |

### Indexes

| Index Name | Table | Definition | Purpose |
| :--- | :--- | :--- | :--- |
| `idx_products_chain_stockcode` | `products` | `(chain, stockcode)` | Fast lookup/upsert by store stockcode |
| `idx_products_name` | `products` | `GIN (to_tsvector('english', name))` | Full-text search on product names |
| `idx_price_history_product_scraped` | `price_history` | `(product_id, scraped_at DESC)` | Fast `DISTINCT ON` latest price & product history queries |
| `idx_price_history_specials` | `price_history` | `(is_on_special) WHERE is_on_special = true` | Partial index for special filtering |

---

## 4. Database Views

Both views are created with `WITH (security_invoker = true)` so caller RLS permissions apply cleanly.

### `public.v_latest_prices`
Returns the **single most recent `price_history` snapshot** for every product joined with `public.products`.

Columns exposed (in order):
`product_id`, `chain`, `stockcode`, `barcode`, `name`, `brand`, `package_size`, `price`, `was_price`, `savings_amount`, `discount_pct`, `is_on_special`, `is_half_price`, `promotion`, `is_multibuy`, `cup_price`, `cup_measure`, `cup_string`, `is_available`, `departments`, `category`, `source`, `region`, `scraped_at`, `url`, `image_url`, `run_id`, `last_seen_at`

* **`scraped_at`**: When the price/special last **changed**.
* **`last_seen_at`**: When the scraper last **verified** the product is still listed at this price.

### `public.v_current_specials`
Filters `public.v_latest_prices` to items where `is_on_special = true`, `is_half_price = true`, `promotion IS NOT NULL`, or `was_price > price`, ordered by `discount_pct DESC NULLS LAST, savings_amount DESC NULLS LAST`.

---

## 5. Security & Row Level Security (RLS)

* **RLS Enabled:** Enabled on `public.scrape_runs`, `public.products`, and `public.price_history`.
* **Read Policies:** `SELECT` allowed for `anon` and `authenticated` roles across all three tables (`USING (true)`).
* **Write Access:** No `INSERT`/`UPDATE`/`DELETE` policies exist for `anon` or `authenticated`. All writes happen exclusively inside `ingest-apify-run` using `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS.

---

## 6. iOS App Integration Guide (Reference for Separate Repo)

When building the iOS client with [`supabase-swift`](https://github.com/supabase/supabase-swift) (or direct PostgREST `URLSession` requests), use the **Project URL** and **Publishable Key** from Section 2.

### Initializing `SupabaseClient`

```swift
import Foundation
import Supabase

let supabase = SupabaseClient(
    supabaseURL: URL(string: "https://wntllezsoavodlrpqcue.supabase.co")!,
    supabaseKey: "sb_publishable_GOqwNwuuM-X77UWa7MdXTg_4pIiU_7l"
)
```

### Swift `Codable` Models

PostgreSQL `numeric(10, 2)` columns are returned by PostgREST as JSON numbers (e.g. `4.45`, `50.00`), and timestamps are returned as ISO 8601 strings with fractional seconds (e.g. `"2026-11-17T01:21:17.088+00:00"`). `supabase-swift` decodes both cleanly with `Date` and `Double`.

```swift
import Foundation

struct GroceryProductPrice: Codable, Identifiable, Sendable {
    var id: UUID { productId }

    let productId: UUID
    let chain: String
    let stockcode: Int64
    let barcode: String?
    let name: String
    let brand: String?
    let packageSize: String?
    let price: Double?
    let wasPrice: Double?
    let savingsAmount: Double?
    let discountPct: Double?
    let isOnSpecial: Bool
    let isHalfPrice: Bool
    let promotion: String?
    let isMultibuy: Bool
    let cupPrice: Double?
    let cupMeasure: String?
    let cupString: String?
    let isAvailable: Bool?
    let departments: [String]?
    let category: String?
    let source: String?
    let region: String?
    let scrapedAt: Date
    let url: String?
    let imageUrl: String?
    let runId: UUID
    let lastSeenAt: Date

    enum CodingKeys: String, CodingKey {
        case productId = "product_id"
        case chain, stockcode, barcode, name, brand
        case packageSize = "package_size"
        case price
        case wasPrice = "was_price"
        case savingsAmount = "savings_amount"
        case discountPct = "discount_pct"
        case isOnSpecial = "is_on_special"
        case isHalfPrice = "is_half_price"
        case promotion
        case isMultibuy = "is_multibuy"
        case cupPrice = "cup_price"
        case cupMeasure = "cup_measure"
        case cupString = "cup_string"
        case isAvailable = "is_available"
        case departments, category, source, region
        case scrapedAt = "scraped_at"
        case url
        case imageUrl = "image_url"
        case runId = "run_id"
        case lastSeenAt = "last_seen_at"
    }
}

struct PriceHistoryPoint: Codable, Identifiable, Sendable {
    let id: UUID
    let productId: UUID
    let runId: UUID
    let price: Double?
    let wasPrice: Double?
    let savingsAmount: Double?
    let discountPct: Double?
    let isOnSpecial: Bool
    let isHalfPrice: Bool
    let promotion: String?
    let cupString: String?
    let isAvailable: Bool?
    let scrapedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case productId = "product_id"
        case runId = "run_id"
        case price
        case wasPrice = "was_price"
        case savingsAmount = "savings_amount"
        case discountPct = "discount_pct"
        case isOnSpecial = "is_on_special"
        case isHalfPrice = "is_half_price"
        case promotion
        case cupString = "cup_string"
        case isAvailable = "is_available"
        case scrapedAt = "scraped_at"
    }
}

struct ScrapeRun: Codable, Identifiable, Sendable {
    let id: UUID
    let apifyRunId: String
    let status: String
    let searchTerms: [String]?
    let itemsReceived: Int
    let productsUpserted: Int
    let priceRecordsInserted: Int
    let startedAt: Date?
    let finishedAt: Date?
    let ingestedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case apifyRunId = "apify_run_id"
        case status
        case searchTerms = "search_terms"
        case itemsReceived = "items_received"
        case productsUpserted = "products_upserted"
        case priceRecordsInserted = "price_records_inserted"
        case startedAt = "started_at"
        case finishedAt = "finished_at"
        case ingestedAt = "ingested_at"
    }
}
```

> **Tip if using raw `JSONDecoder` instead of `supabase-swift`:** Configure `decoder.dateDecodingStrategy` with `ISO8601DateFormatter` using `[.withInternetDateTime, .withFractionalSeconds]` so fractional timestamps like `"2026-11-17T01:21:17.088+00:00"` parse cleanly.

### Common Queries for iOS Screens

```swift
// 1. Specials tab — top current discounts (half-price first)
let specials: [GroceryProductPrice] = try await supabase
    .from("v_current_specials")
    .select()
    .range(from: 0, to: 49)
    .execute()
    .value

// 2. Search bar — search latest prices by name (case-insensitive)
let milkResults: [GroceryProductPrice] = try await supabase
    .from("v_latest_prices")
    .select()
    .ilike("name", pattern: "%milk%")
    .order("price", ascending: true)
    .limit(50)
    .execute()
    .value

// 3. Freshness filter — only show products verified in the last 48 hours
let cutoffISO = Date().addingTimeInterval(-48 * 3600).ISO8601Format()
let freshSpecials: [GroceryProductPrice] = try await supabase
    .from("v_current_specials")
    .select()
    .gte("last_seen_at", value: cutoffISO)
    .execute()
    .value

// 4. Product detail chart — historical price changes for one product
let history: [PriceHistoryPoint] = try await supabase
    .from("price_history")
    .select("id,product_id,run_id,price,was_price,savings_amount,discount_pct,is_on_special,is_half_price,promotion,cup_string,is_available,scraped_at")
    .eq("product_id", value: productId.uuidString)
    .order("scraped_at", ascending: false)
    .execute()
    .value

// 5. Last sync status banner
let recentRuns: [ScrapeRun] = try await supabase
    .from("scrape_runs")
    .select()
    .order("ingested_at", ascending: false)
    .limit(5)
    .execute()
    .value
```

---

## 7. Repository Structure & Deployment Cheat Sheet

```text
woolworths-actor/
├── .actor/
│   ├── actor.json                 # Apify actor metadata (woolworths-au-prices)
│   ├── input_schema.json          # Apify Console input form
│   └── dataset_schema.json        # Apify dataset table view config
├── src/
│   └── main.js                    # Playwright + in-browser Woolworths API scraper
├── supabase/
│   ├── config.toml                # Supabase project ref & Edge Function config
│   ├── migrations/
│   │   ├── 20261117000001_create_grocery_schema.sql
│   │   └── 20261117000002_add_last_seen_to_views.sql
│   └── functions/
│       └── ingest-apify-run/
│           └── index.ts           # Webhook handler + change-only price ingestion
├── .dockerignore                  # Excludes supabase/, docs/, node_modules/ from Actor image
├── Dockerfile                     # Apify Playwright Chrome runtime image
├── package.json                   # Actor dependencies + Supabase CLI scripts
├── README.md
└── architecture.md                # This file
```

### Deployment Commands

| Component Changed | Command (from `woolworths-actor/`) |
| :--- | :--- |
| Woolworths scraper (`src/main.js`) | `apify push` |
| Edge Function (`supabase/functions/ingest-apify-run/index.ts`) | `npm run supabase:functions:deploy` |
| New SQL migration (`supabase/migrations/*.sql`) | `npm run supabase:db:push` |
| Both migrations & Edge Function | `npm run supabase:deploy` |
