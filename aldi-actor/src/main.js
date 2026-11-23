import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import { normalizeProduct } from './normalize.js';

const BASE_URL = 'https://www.aldi.com.au';
const API_BASE = 'https://api.aldi.com.au';
const PAGE_SIZE = 30;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Execute a GET request to ALDI's JSON API.
 * Uses Playwright's context.request (shares proxy & cookies, immune to CORS/DOM issues),
 * with a simple retry on transient proxy/network errors.
 */
async function apiGet(context, url, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await context.request.get(url, {
                headers: {
                    Accept: 'application/json, text/plain, */*',
                    Origin: BASE_URL,
                    Referer: `${BASE_URL}/`,
                },
                timeout: 30000,
            });
            const status = res.status();
            const text = await res.text();
            let json = null;
            try {
                json = JSON.parse(text);
            } catch {
                // non-JSON response (e.g. WAF challenge or HTML error)
            }
            if (res.ok() || attempt === retries) {
                return { ok: res.ok(), status, json, snippet: text.slice(0, 240) };
            }
        } catch (err) {
            if (attempt === retries) {
                return { ok: false, status: 0, json: null, snippet: String(err) };
            }
        }
        await sleep(1500 * (attempt + 1));
    }
    return { ok: false, status: 0, json: null, snippet: 'Exhausted retries' };
}

/**
 * Extract the product array from ALDI's v3 product-search response envelope.
 */
function extractProductsFromSearchResponse(json) {
    if (!json || typeof json !== 'object') return { items: [], total: 0 };
    if (Array.isArray(json.data)) {
        const total = json.meta?.pagination?.totalCount ?? json.data.length;
        return { items: json.data, total };
    }
    if (Array.isArray(json.data?.products)) {
        const total = json.totalResults ?? json.data.products.length;
        return { items: json.data.products, total };
    }
    return { items: [], total: 0 };
}

await Actor.init();

let browser;
try {
    const input = (await Actor.getInput()) ?? {};
    const {
        searchTerms = ['milk'],
        skus = [],
        maxItemsPerSearch = 36,
        serviceType = 'walk-in',
        region = 'au',
        delayMs = 1200,
        proxyConfiguration: proxyConfigInput,
    } = input;

    let launchProxy;
    if (proxyConfigInput && proxyConfigInput.useApifyProxy !== false) {
        const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfigInput);
        if (proxyConfiguration) {
            const sessionId = `aldi_${Date.now()}`;
            const proxyUrl = await proxyConfiguration.newUrl(sessionId);
            const parsed = new URL(proxyUrl);
            launchProxy = {
                server: `${parsed.protocol}//${parsed.host}`,
                username: decodeURIComponent(parsed.username),
                password: decodeURIComponent(parsed.password),
            };
            log.info('Using Apify proxy', { server: launchProxy.server, sessionId });
        }
    } else {
        log.info('Running without proxy');
    }

    browser = await chromium.launch({
        channel: 'chrome',
        headless: true,
        proxy: launchProxy,
        args: ['--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
        userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        locale: 'en-AU',
        timezoneId: 'Australia/Sydney',
        viewport: { width: 1366, height: 900 },
    });

    const page = await context.newPage();

    log.info('Bootstrapping session on aldi.com.au...');
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const homeResp = await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
            log.info('Homepage loaded', { status: homeResp?.status(), url: page.url(), attempt });
            await sleep(1200);
            break;
        } catch (err) {
            log.warning(`Homepage bootstrap attempt ${attempt}/3 failed: ${err?.message || err}`);
            if (attempt < 3) await sleep(2000 * attempt);
        }
    }

    const seenStockcodes = new Set();
    let totalPushed = 0;

    // 1. Keyword searches via api.aldi.com.au/v3/product-search
    for (const rawTerm of searchTerms) {
        const term = String(rawTerm).trim();
        if (!term) continue;

        log.info(`Searching ALDI AU for "${term}" (max ${maxItemsPerSearch})...`);
        let collected = 0;
        let offset = 0;

        // ALDI accepts only specific page sizes. Apply the product cap after deduplication.
        while (collected < maxItemsPerSearch) {
            const params = new URLSearchParams({
                currency: 'AUD',
                serviceType,
                q: term,
                limit: String(PAGE_SIZE),
                offset: String(offset),
                sort: 'relevance',
            });
            const url = `${API_BASE}/v3/product-search?${params.toString()}`;
            const res = await apiGet(context, url);

            if (!res.ok || !res.json) {
                log.warning('ALDI search API request failed', {
                    term,
                    offset,
                    status: res.status,
                    snippet: res.snippet,
                });
                break;
            }

            const { items, total } = extractProductsFromSearchResponse(res.json);
            if (items.length === 0) {
                log.info(`No more results for "${term}" at offset ${offset}`);
                break;
            }

            const batch = [];
            for (const raw of items) {
                if (collected >= maxItemsPerSearch) break;
                const item = normalizeProduct(raw, {
                    source: `search:${term}`,
                    region,
                });
                if (!item || seenStockcodes.has(item.stockcode)) continue;
                seenStockcodes.add(item.stockcode);
                batch.push(item);
                collected += 1;
            }

            if (batch.length > 0) {
                await Actor.pushData(batch);
                totalPushed += batch.length;
                log.info(`Pushed ${batch.length} items for "${term}" (collected ${collected}/${Math.min(maxItemsPerSearch, total)})`);
            }

            offset += items.length;
            if (offset >= total || items.length < PAGE_SIZE) break;
            if (delayMs > 0) await sleep(delayMs);
        }

        if (delayMs > 0) await sleep(delayMs);
    }

    // 2. Direct SKU lookups via api.aldi.com.au/v2/products/{sku}
    for (const rawSku of skus) {
        const sku = String(rawSku).trim();
        if (!sku) continue;

        log.info(`Fetching ALDI AU product SKU ${sku}...`);
        const url = `${API_BASE}/v2/products/${encodeURIComponent(sku)}?serviceType=${encodeURIComponent(serviceType)}`;
        const res = await apiGet(context, url);

        if (!res.ok || !res.json?.data) {
            log.warning('ALDI product detail API request failed', {
                sku,
                status: res.status,
                snippet: res.snippet,
            });
        } else {
            const item = normalizeProduct(res.json.data, {
                source: `sku:${sku}`,
                region,
            });
            if (item && !seenStockcodes.has(item.stockcode)) {
                seenStockcodes.add(item.stockcode);
                await Actor.pushData(item);
                totalPushed += 1;
                log.info(`Pushed SKU ${sku}: ${item.name} ($${item.price})`);
            }
        }

        if (delayMs > 0) await sleep(delayMs);
    }

    log.info(`Done! Total ALDI AU products pushed: ${totalPushed}`);
} catch (err) {
    log.exception(err, 'ALDI AU actor failed');
    await Actor.fail(err?.message || String(err));
} finally {
    if (browser) await browser.close();
}

await Actor.exit();
