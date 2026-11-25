import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import { normalizeProduct } from './normalize.js';

const BASE_URL = 'https://www.aldi.com.au';
const API_BASE = 'https://api.aldi.com.au';
const PAGE_SIZE = 30;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll briefly for Akamai's _abck cookie if the site sets one.
 */
async function waitForBotCookie(context, timeoutMs = 8_000) {
    const start = Date.now();
    const deadline = start + timeoutMs;
    let sawAbck = false;
    while (Date.now() < deadline) {
        const cookies = await context.cookies(BASE_URL);
        const abck = cookies.find((c) => c.name === '_abck');
        if (abck) sawAbck = true;
        if (abck?.value.includes('~0~')) {
            log.info('Akamai _abck cookie validated');
            return true;
        }
        // If ALDI doesn't set _abck at all after 2s, don't wait the full timeout.
        if (!sawAbck && Date.now() - start >= 2_000) {
            break;
        }
        await sleep(1000);
    }
    if (sawAbck) {
        log.warning('_abck cookie present but not validated in time; continuing anyway.');
    }
    return false;
}

let sessionCounter = 0;

async function launchSessionOnce(proxyConfiguration) {
    let launchProxy;
    if (proxyConfiguration) {
        const sessionId = `aldi_${Date.now()}_${sessionCounter++}`;
        const proxyUrl = await proxyConfiguration.newUrl(sessionId);
        const parsed = new URL(proxyUrl);
        launchProxy = {
            server: `${parsed.protocol}//${parsed.host}`,
            username: decodeURIComponent(parsed.username),
            password: decodeURIComponent(parsed.password),
        };
        log.info('Using Apify proxy', { server: launchProxy.server, sessionId });
    }

    const browser = await chromium.launch({
        // Headed under Xvfb on Apify is much less detectable by Akamai than headless.
        headless: !Actor.isAtHome(),
        proxy: launchProxy,
        ...(Actor.isAtHome() ? { channel: 'chrome' } : {}),
        args: ['--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
        locale: 'en-AU',
        timezoneId: 'Australia/Sydney',
        viewport: { width: 1366, height: 900 },
    });

    const page = await context.newPage();
    // Skip heavy static assets and Dynatrace RUM (which wraps window.fetch and injects x-dtpc headers).
    await page.route('**/*.{png,jpg,jpeg,webp,gif,svg,woff,woff2,mp4}', (r) => r.abort());
    await page.route('**/ruxitagentjs*', (r) => r.abort());

    try {
        log.info('Bootstrapping session on aldi.com.au...');
        const homeResp = await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        log.info('Homepage loaded', { status: homeResp?.status(), url: page.url() });
        await waitForBotCookie(context);
        return { browser, context, page };
    } catch (err) {
        await browser.close().catch(() => {});
        throw err;
    }
}

async function launchSession(proxyConfiguration, maxAttempts = 4) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await launchSessionOnce(proxyConfiguration);
        } catch (err) {
            log.warning(`Session bootstrap failed (attempt ${attempt}/${maxAttempts}): ${err?.message?.split('\n')[0] || err}`);
            if (attempt >= maxAttempts) throw err;
            await sleep(2000 * attempt);
        }
    }
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

let session;
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

    let proxyConfiguration = null;
    if (proxyConfigInput && proxyConfigInput.useApifyProxy !== false) {
        proxyConfiguration = await Actor.createProxyConfiguration(proxyConfigInput);
    } else {
        log.info('Running without proxy');
    }

    session = await launchSession(proxyConfiguration);

    /**
     * Execute a GET request to ALDI's JSON API from inside the browser
     * so requests carry real Chrome TLS/HTTP2 fingerprints, sec-ch-ua headers,
     * and Akamai cookies. Falls back to direct browser navigation on api.aldi.com.au
     * if cross-origin fetch is blocked by CSP/CORS, and rotates the browser + proxy
     * session on 403/429.
     */
    async function apiGet(url, attempt = 1, maxAttempts = 3) {
        let res;
        try {
            res = await session.page.evaluate(async (targetUrl) => {
                const doFetch = (credentials) =>
                    fetch(targetUrl, {
                        method: 'GET',
                        credentials,
                        headers: {
                            Accept: 'application/json, text/plain, */*',
                        },
                    });

                let r;
                try {
                    r = await doFetch('include');
                } catch {
                    r = await doFetch('omit');
                }
                const text = await r.text();
                let json = null;
                try {
                    json = JSON.parse(text);
                } catch {
                    // non-JSON response (e.g. WAF challenge or HTML error)
                }
                return { ok: r.ok, status: r.status, json, snippet: json ? null : text.slice(0, 240) };
            }, url);
        } catch (err) {
            // If CSP/CORS blocks cross-origin fetch from www.aldi.com.au, load the API URL
            // directly in a tab (real Chrome TLS/HTTP2 + cookies, zero CORS/CSP restrictions).
            const navPage = await session.context.newPage();
            try {
                const resp = await navPage.goto(url, {
                    waitUntil: 'domcontentloaded',
                    referer: `${BASE_URL}/`,
                    timeout: 30_000,
                });
                const status = resp?.status() ?? 0;
                const text = resp ? await resp.text() : '';
                let json = null;
                try {
                    json = JSON.parse(text);
                } catch {
                    // non-JSON response
                }
                res = { ok: status >= 200 && status < 300, status, json, snippet: json ? null : text.slice(0, 240) };
            } catch (navErr) {
                res = {
                    ok: false,
                    status: 0,
                    json: null,
                    snippet: `fetch failed (${err?.message || err}); nav failed (${navErr?.message || navErr})`,
                };
            } finally {
                await navPage.close().catch(() => {});
            }
        }

        if (res.ok && res.json) return res;
        if (res.status === 404 || attempt >= maxAttempts) return res;

        log.warning(`ALDI API request returned ${res.status} (attempt ${attempt}/${maxAttempts}); rotating session...`, {
            snippet: res.snippet,
        });
        await sleep(4000 * attempt);
        await session.browser.close().catch(() => {});
        session = await launchSession(proxyConfiguration);
        return apiGet(url, attempt + 1, maxAttempts);
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
            const res = await apiGet(url);

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
        const res = await apiGet(url);

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

    if (totalPushed === 0 && (searchTerms.length > 0 || skus.length > 0)) {
        throw new Error('No ALDI AU products were collected (likely blocked). Try a RESIDENTIAL AU proxy.');
    }

    log.info(`Done! Total ALDI AU products pushed: ${totalPushed}`);
} catch (err) {
    log.exception(err, 'ALDI AU actor failed');
    await Actor.fail(err?.message || String(err));
} finally {
    if (session?.browser) await session.browser.close().catch(() => {});
}

await Actor.exit();
