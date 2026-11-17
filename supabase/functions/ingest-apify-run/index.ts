import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const APIFY_API_BASE = "https://api.apify.com/v2";
const BATCH_SIZE = 500;
const LOOKUP_BATCH_SIZE = 100;

interface RawApifyItem {
  chain?: string | null;
  stockcode?: number | string | null;
  barcode?: string | null;
  name?: string | null;
  brand?: string | null;
  packageSize?: string | null;
  price?: number | string | null;
  wasPrice?: number | string | null;
  savingsAmount?: number | string | null;
  isOnSpecial?: boolean | null;
  isHalfPrice?: boolean | null;
  promotion?: string | null;
  isMultibuy?: boolean | null;
  departments?: string[] | null;
  category?: string | null;
  productLimit?: number | string | null;
  cupPrice?: number | string | null;
  cupMeasure?: string | null;
  cupString?: string | null;
  isAvailable?: boolean | null;
  url?: string | null;
  imageUrl?: string | null;
  source?: string | null;
  region?: string | null;
  scrapedAt?: string | null;
}

interface NormalizedItem {
  chain: string;
  stockcode: number;
  barcode: string | null;
  name: string;
  brand: string | null;
  packageSize: string | null;
  departments: string[] | null;
  category: string | null;
  url: string | null;
  imageUrl: string | null;
  price: number | null;
  wasPrice: number | null;
  savingsAmount: number | null;
  isOnSpecial: boolean;
  isHalfPrice: boolean;
  promotion: string | null;
  isMultibuy: boolean;
  productLimit: number | null;
  cupPrice: number | null;
  cupMeasure: string | null;
  cupString: string | null;
  isAvailable: boolean | null;
  sources: string[];
  region: string | null;
  scrapedAt: string;
}

function toFiniteNumber(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function toInt(val: unknown): number | null {
  const n = toFiniteNumber(val);
  return n !== null ? Math.trunc(n) : null;
}

function toIsoTimestamp(val: unknown, fallbackIso: string): string {
  if (typeof val === "string" && val.trim()) {
    const ms = Date.parse(val);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return fallbackIso;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-apify-token",
    },
  });
}

async function fetchApifyJson<T>(url: string, token?: string | null): Promise<T | null> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apify API ${res.status} for ${url}: ${text.slice(0, 300)}`);
  }
  return await res.json() as T;
}

function deduplicateItems(rawItems: RawApifyItem[], fallbackScrapedAt: string): NormalizedItem[] {
  const map = new Map<string, NormalizedItem>();

  for (const raw of rawItems) {
    const stockcode = toInt(raw.stockcode);
    if (stockcode === null || stockcode <= 0) continue;

    const chain = (typeof raw.chain === "string" && raw.chain.trim()) || "woolworths";
    const key = `${chain}::${stockcode}`;
    const scrapedAt = toIsoTimestamp(raw.scrapedAt, fallbackScrapedAt);
    const sourceStr = typeof raw.source === "string" && raw.source.trim() ? raw.source.trim() : null;

    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        chain,
        stockcode,
        barcode: typeof raw.barcode === "string" ? raw.barcode : null,
        name: (typeof raw.name === "string" && raw.name.trim()) || `Product ${stockcode}`,
        brand: typeof raw.brand === "string" ? raw.brand : null,
        packageSize: typeof raw.packageSize === "string" ? raw.packageSize : null,
        departments: Array.isArray(raw.departments) ? raw.departments.map(String) : null,
        category: typeof raw.category === "string" ? raw.category : null,
        url: typeof raw.url === "string" ? raw.url : null,
        imageUrl: typeof raw.imageUrl === "string" ? raw.imageUrl : null,
        price: toFiniteNumber(raw.price),
        wasPrice: toFiniteNumber(raw.wasPrice),
        savingsAmount: toFiniteNumber(raw.savingsAmount),
        isOnSpecial: Boolean(raw.isOnSpecial),
        isHalfPrice: Boolean(raw.isHalfPrice),
        promotion: typeof raw.promotion === "string" ? raw.promotion : null,
        isMultibuy: Boolean(raw.isMultibuy),
        productLimit: toInt(raw.productLimit),
        cupPrice: toFiniteNumber(raw.cupPrice),
        cupMeasure: typeof raw.cupMeasure === "string" ? raw.cupMeasure : null,
        cupString: typeof raw.cupString === "string" ? raw.cupString : null,
        isAvailable: typeof raw.isAvailable === "boolean" ? raw.isAvailable : null,
        sources: sourceStr ? [sourceStr] : [],
        region: typeof raw.region === "string" ? raw.region : null,
        scrapedAt,
      });
      continue;
    }

    if (sourceStr && !existing.sources.includes(sourceStr)) {
      existing.sources.push(sourceStr);
    }

    if (Date.parse(scrapedAt) > Date.parse(existing.scrapedAt)) {
      existing.barcode = typeof raw.barcode === "string" ? raw.barcode : existing.barcode;
      existing.name = (typeof raw.name === "string" && raw.name.trim()) || existing.name;
      existing.brand = typeof raw.brand === "string" ? raw.brand : existing.brand;
      existing.packageSize = typeof raw.packageSize === "string" ? raw.packageSize : existing.packageSize;
      existing.departments = Array.isArray(raw.departments) ? raw.departments.map(String) : existing.departments;
      existing.category = typeof raw.category === "string" ? raw.category : existing.category;
      existing.url = typeof raw.url === "string" ? raw.url : existing.url;
      existing.imageUrl = typeof raw.imageUrl === "string" ? raw.imageUrl : existing.imageUrl;
      existing.price = toFiniteNumber(raw.price);
      existing.wasPrice = toFiniteNumber(raw.wasPrice);
      existing.savingsAmount = toFiniteNumber(raw.savingsAmount);
      existing.isOnSpecial = Boolean(raw.isOnSpecial);
      existing.isHalfPrice = Boolean(raw.isHalfPrice);
      existing.promotion = typeof raw.promotion === "string" ? raw.promotion : null;
      existing.isMultibuy = Boolean(raw.isMultibuy);
      existing.productLimit = toInt(raw.productLimit);
      existing.cupPrice = toFiniteNumber(raw.cupPrice);
      existing.cupMeasure = typeof raw.cupMeasure === "string" ? raw.cupMeasure : null;
      existing.cupString = typeof raw.cupString === "string" ? raw.cupString : null;
      existing.isAvailable = typeof raw.isAvailable === "boolean" ? raw.isAvailable : null;
      existing.region = typeof raw.region === "string" ? raw.region : existing.region;
      existing.scrapedAt = scrapedAt;
    }
  }

  return Array.from(map.values());
}

function deriveSearchTerms(items: RawApifyItem[]): string[] | null {
  const terms: string[] = [];
  for (const item of items) {
    if (typeof item.source !== "string" || !item.source.trim()) continue;
    const s = item.source.trim();
    const term = s.startsWith("search:") ? s.slice("search:".length) : s;
    if (term && !terms.includes(term)) terms.push(term);
  }
  return terms.length > 0 ? terms : null;
}

interface LatestPriceRow {
  product_id: string;
  price: number | string | null;
  was_price: number | string | null;
  is_on_special: boolean | null;
  is_half_price: boolean | null;
  promotion: string | null;
  is_available: boolean | null;
}

function hasPriceChanged(item: NormalizedItem, latest: LatestPriceRow | undefined): boolean {
  if (!latest) return true;
  return (
    toFiniteNumber(latest.price) !== item.price ||
    toFiniteNumber(latest.was_price) !== item.wasPrice ||
    Boolean(latest.is_on_special) !== item.isOnSpecial ||
    Boolean(latest.is_half_price) !== item.isHalfPrice ||
    (latest.promotion ?? null) !== (item.promotion ?? null) ||
    (latest.is_available ?? null) !== (item.isAvailable ?? null)
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return jsonResponse({ ok: true });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, 500);
    }

    const url = new URL(req.url);
    const apifyToken =
      req.headers.get("x-apify-token") ||
      url.searchParams.get("apify_token") ||
      Deno.env.get("APIFY_API_TOKEN") ||
      null;

    // deno-lint-ignore no-explicit-any
    let body: Record<string, any> = {};
    if (req.method !== "GET") {
      const rawText = await req.text();
      if (rawText.trim()) {
        body = JSON.parse(rawText);
      }
    }

    const resource = body.resource ?? {};
    const eventData = body.eventData ?? {};

    let runId: string | null =
      body.runId ?? resource.id ?? eventData.actorRunId ?? url.searchParams.get("runId") ?? null;
    let datasetId: string | null =
      body.datasetId ?? resource.defaultDatasetId ?? url.searchParams.get("datasetId") ?? null;
    let keyValueStoreId: string | null =
      body.keyValueStoreId ?? resource.defaultKeyValueStoreId ?? null;
    let actorId: string | null = body.actorId ?? resource.actId ?? eventData.actorId ?? null;
    let runStatus: string = body.status ?? resource.status ?? "SUCCEEDED";
    let startedAt: string | null = body.startedAt ?? resource.startedAt ?? null;
    let finishedAt: string | null = body.finishedAt ?? resource.finishedAt ?? null;

    if (!runId && !datasetId) {
      return jsonResponse(
        { error: "Provide runId, datasetId, or an Apify webhook payload with resource.id / resource.defaultDatasetId." },
        400,
      );
    }

    // Fetch run metadata from Apify if datasetId or run metadata is missing
    if (runId && (!datasetId || !keyValueStoreId || !startedAt)) {
      const runResp = await fetchApifyJson<{
        data?: {
          id?: string;
          actId?: string;
          status?: string;
          startedAt?: string;
          finishedAt?: string;
          defaultDatasetId?: string;
          defaultKeyValueStoreId?: string;
        };
      }>(`${APIFY_API_BASE}/actor-runs/${encodeURIComponent(runId)}`, apifyToken);

      if (runResp?.data) {
        datasetId = datasetId ?? runResp.data.defaultDatasetId ?? null;
        keyValueStoreId = keyValueStoreId ?? runResp.data.defaultKeyValueStoreId ?? null;
        actorId = actorId ?? runResp.data.actId ?? null;
        runStatus = runResp.data.status ?? runStatus;
        startedAt = startedAt ?? runResp.data.startedAt ?? null;
        finishedAt = finishedAt ?? runResp.data.finishedAt ?? null;
      }
    }

    if (!datasetId) {
      return jsonResponse({ error: `Could not resolve datasetId for runId=${runId}` }, 400);
    }

    // Fetch INPUT from Key-Value Store if available to capture searchTerms
    let searchTerms: string[] | null = null;
    if (keyValueStoreId) {
      try {
        const inputRecord = await fetchApifyJson<{ searchTerms?: unknown[] }>(
          `${APIFY_API_BASE}/key-value-stores/${encodeURIComponent(keyValueStoreId)}/records/INPUT`,
          apifyToken,
        );
        if (inputRecord && Array.isArray(inputRecord.searchTerms) && inputRecord.searchTerms.length > 0) {
          searchTerms = inputRecord.searchTerms.map(String);
        }
      } catch (err) {
        console.warn("Could not fetch INPUT record:", err);
      }
    }

    // Fetch dataset items
    const rawItems = await fetchApifyJson<RawApifyItem[]>(
      `${APIFY_API_BASE}/datasets/${encodeURIComponent(datasetId)}/items?clean=true&format=json`,
      apifyToken,
    );

    if (!Array.isArray(rawItems)) {
      return jsonResponse({ error: `Dataset ${datasetId} did not return an item array` }, 502);
    }

    if (!searchTerms) {
      searchTerms = deriveSearchTerms(rawItems);
    }

    const nowIso = new Date().toISOString();
    const effectiveRunId = runId ?? `dataset:${datasetId}`;
    const deduped = deduplicateItems(rawItems, finishedAt ?? nowIso);
    const primaryChain = deduped[0]?.chain ?? "woolworths";

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // 1. Upsert scrape_runs record
    const { data: runRow, error: runErr } = await supabase
      .from("scrape_runs")
      .upsert(
        {
          apify_run_id: effectiveRunId,
          actor_id: actorId,
          dataset_id: datasetId,
          chain: primaryChain,
          status: runStatus,
          search_terms: searchTerms,
          items_received: rawItems.length,
          started_at: startedAt,
          finished_at: finishedAt,
          ingested_at: nowIso,
        },
        { onConflict: "apify_run_id" },
      )
      .select("id")
      .single();

    if (runErr || !runRow) {
      throw new Error(`Failed to upsert scrape_runs: ${runErr?.message ?? "unknown error"}`);
    }

    const dbRunId = runRow.id as string;

    // 2. Upsert unique products in batches
    const productIdMap = new Map<string, string>();
    for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
      const batch = deduped.slice(i, i + BATCH_SIZE).map((item) => ({
        chain: item.chain,
        stockcode: item.stockcode,
        barcode: item.barcode,
        name: item.name,
        brand: item.brand,
        package_size: item.packageSize,
        departments: item.departments,
        category: item.category,
        url: item.url,
        image_url: item.imageUrl,
        last_seen_at: item.scrapedAt,
        updated_at: nowIso,
      }));

      const { data: upsertedProducts, error: prodErr } = await supabase
        .from("products")
        .upsert(batch, { onConflict: "chain,stockcode" })
        .select("id, chain, stockcode");

      if (prodErr) {
        throw new Error(`Failed to upsert products batch: ${prodErr.message}`);
      }

      for (const p of upsertedProducts ?? []) {
        productIdMap.set(`${p.chain}::${p.stockcode}`, p.id as string);
      }
    }

    // 3. Fetch current latest prices to only record new or changed items
    const productIds = Array.from(productIdMap.values());
    const latestPriceMap = new Map<string, LatestPriceRow>();
    for (let i = 0; i < productIds.length; i += LOOKUP_BATCH_SIZE) {
      const idBatch = productIds.slice(i, i + LOOKUP_BATCH_SIZE);
      const { data: latestRows, error: latestErr } = await supabase
        .from("v_latest_prices")
        .select("product_id, price, was_price, is_on_special, is_half_price, promotion, is_available")
        .in("product_id", idBatch);

      if (latestErr) {
        throw new Error(`Failed to fetch v_latest_prices batch: ${latestErr.message}`);
      }

      for (const row of (latestRows ?? []) as LatestPriceRow[]) {
        latestPriceMap.set(row.product_id, row);
      }
    }

    const changedRows = deduped
      .map((item) => {
        const productId = productIdMap.get(`${item.chain}::${item.stockcode}`);
        if (!productId) return null;
        if (!hasPriceChanged(item, latestPriceMap.get(productId))) return null;
        return {
          product_id: productId,
          run_id: dbRunId,
          chain: item.chain,
          stockcode: item.stockcode,
          price: item.price,
          was_price: item.wasPrice,
          savings_amount: item.savingsAmount,
          is_on_special: item.isOnSpecial,
          is_half_price: item.isHalfPrice,
          promotion: item.promotion,
          is_multibuy: item.isMultibuy,
          product_limit: item.productLimit,
          cup_price: item.cupPrice,
          cup_measure: item.cupMeasure,
          cup_string: item.cupString,
          is_available: item.isAvailable,
          source: item.sources.length > 0 ? item.sources.join(", ") : null,
          region: item.region,
          scraped_at: item.scrapedAt,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    const unchangedSkipped = productIdMap.size - changedRows.length;

    // 4. Upsert changed price_history rows in batches
    let priceRecordsInserted = 0;
    for (let i = 0; i < changedRows.length; i += BATCH_SIZE) {
      const batch = changedRows.slice(i, i + BATCH_SIZE);
      const { error: priceErr } = await supabase
        .from("price_history")
        .upsert(batch, { onConflict: "run_id,product_id" });

      if (priceErr) {
        throw new Error(`Failed to upsert price_history batch: ${priceErr.message}`);
      }
      priceRecordsInserted += batch.length;
    }

    // 5. Update scrape_runs with final counts
    const { error: updateRunErr } = await supabase
      .from("scrape_runs")
      .update({
        items_received: rawItems.length,
        products_upserted: productIdMap.size,
        price_records_inserted: priceRecordsInserted,
        ingested_at: new Date().toISOString(),
      })
      .eq("id", dbRunId);

    if (updateRunErr) {
      throw new Error(`Failed to update scrape_runs counts: ${updateRunErr.message}`);
    }

    return jsonResponse({
      ok: true,
      dbRunId,
      apifyRunId: effectiveRunId,
      datasetId,
      searchTerms,
      itemsReceived: rawItems.length,
      productsUpserted: productIdMap.size,
      priceRecordsInserted,
      unchangedSkipped,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("ingest-apify-run error:", message);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
