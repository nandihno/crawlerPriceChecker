import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import { extractSearchResults, normalizeProduct } from './normalize.js';

const BASE_URL = 'https://www.coles.com.au';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read `#__NEXT_DATA__` JSON from the currently loaded Coles page.
 */
async function readNextData(page) {
    return page.evaluate(() => {
        const el = document.querySelector('#__NEXT_DATA__');
        if (!el || !el.textContent) return null;
        try {
            return JSON.parse(el.textContent);
        } catch {
            return null;
        }
    });
}

/**
 * Fetch a Next.js `_next/data` JSON route from inside the browser page
 * (same-origin, inherits Imperva/Incapsula cookies and TLS fingerprint).
 */
async function fetchNextDataRoute(page, pathWithQuery) {
    return page.evaluate(async (urlPath) => {
        try {
            const res = await fetch(urlPath, {
                method: 'GET',
                credentials: 'include',
                headers: {
                    Accept: 'application/json, */*',
                    'x-nextjs-data': '1',
                },
            });
            const text = await res.text();
            let json = null;
            try {
                json = JSON.parse(text);
            } catch {
                // HTML or Imperva challenge page
            }
            return { ok: res.ok, status: res.status, json, snippet: text.slice(0, 240) };
        } catch (err) {
            return { ok: false, status: 0, json: null, snippet: String(err) };
        }
    }, pathWithQuery);
}

/**
 * Navigate to a Coles page with retries and return its parsed `#__NEXT_DATA__`.
 */
async function gotoAndReadNextData(page, url, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await sleep(1200);
            const nextData = await readNextData(page);
            if (nextData) {
                return { ok: true, status: resp?.status() ?? 200, nextData };
            }
            log.warning('No #__NEXT_DATA__ found on page', {
                url,
                status: resp?.status(),
                attempt: attempt + 1,
                title: await page.title().catch(() => ''),
            });
        } catch (err) {
            log.warning(`Navigation attempt ${attempt + 1}/${retries + 1} failed: ${err?.message || err}`, { url });
        }
        if (attempt < retries) await sleep(2000 * (attempt + 1));
    }
    return { ok: false, status: 0, nextData: null };
}

await Actor.init();

let browser;
try {
    const input = (await Actor.getInput()) ?? {};
    const {
        searchTerms = ['milk'],
        productIds = [],
        maxItemsPerSearch = 48,
        region = 'au',
        delayMs = 1500,
        proxyConfiguration: proxyConfigInput,
    } = input;

    let launchProxy;
    if (proxyConfigInput && proxyConfigInput.useApifyProxy !== false) {
        const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfigInput);
        if (proxyConfiguration) {
            const sessionId = `coles_${Date.now()}`;
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

    log.info('Bootstrapping session on coles.com.au...');
    const homeRes = await gotoAndReadNextData(page, `${BASE_URL}/`, 2);
    let buildId = homeRes.nextData?.buildId || null;
    log.info('Homepage bootstrap finished', { ok: homeRes.ok, status: homeRes.status, buildId });

    const seenStockcodes = new Set();
    let totalPushed = 0;

    // 1. Keyword searches
    for (const rawTerm of searchTerms) {
        const term = String(rawTerm).trim();
        if (!term) continue;

        log.info(`Searching Coles AU for "${term}" (max ${maxItemsPerSearch})...`);
        let collected = 0;
        let pageNum = 1;

        while (collected < maxItemsPerSearch) {
            let payload = null;

            // Fast path: Next.js JSON data route
            if (buildId) {
                const jsonPath = `/_next/data/${encodeURIComponent(buildId)}/search/products.json?q=${encodeURIComponent(term)}&page=${pageNum}`;
                const res = await fetchNextDataRoute(page, jsonPath);
                if (res.ok && res.json) {
                    payload = res.json;
                } else {
                    log.warning('Coles _next/data fetch failed, falling back to full page load', {
                        term,
                        pageNum,
                        status: res.status,
                        snippet: res.snippet,
                    });
                }
            }

            // Fallback path: full SSR page navigation + #__NEXT_DATA__
            if (!payload) {
                const searchUrl = `${BASE_URL}/search/products?q=${encodeURIComponent(term)}&page=${pageNum}`;
                const navRes = await gotoAndReadNextData(page, searchUrl, 1);
                if (navRes.ok && navRes.nextData) {
                    if (navRes.nextData.buildId) buildId = navRes.nextData.buildId;
                    payload = navRes.nextData;
                } else {
                    log.warning('Coles search page load failed', { term, pageNum, status: navRes.status });
                    break;
                }
            }

            const { items, total, pageSize } = extractSearchResults(payload);
            if (items.length === 0) {
                log.info(`No more results for "${term}" on page ${pageNum}`);
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
                log.info(`Pushed ${batch.length} items for "${term}" (page ${pageNum}, collected ${collected}/${Math.min(maxItemsPerSearch, total)})`);
            }

            if (pageNum * pageSize >= total || items.length === 0) break;
            pageNum += 1;
            if (delayMs > 0) await sleep(delayMs);
        }

        if (delayMs > 0) await sleep(delayMs);
    }

    // 2. Direct product ID lookups
    for (const rawId of productIds) {
        const id = String(rawId).trim();
        if (!id) continue;

        log.info(`Fetching Coles AU product ${id}...`);
        const navRes = await gotoAndReadNextData(page, `${BASE_URL}/product/${encodeURIComponent(id)}`, 1);
        const product = navRes.nextData?.props?.pageProps?.product ?? null;

        if (!product) {
            log.warning('Coles product detail lookup failed', { id, status: navRes.status });
        } else {
            const item = normalizeProduct(product, {
                source: `product:${id}`,
                region,
            });
            if (item && !seenStockcodes.has(item.stockcode)) {
                seenStockcodes.add(item.stockcode);
                await Actor.pushData(item);
                totalPushed += 1;
                log.info(`Pushed product ${id}: ${item.name} ($${item.price})`);
            }
        }

        if (delayMs > 0) await sleep(delayMs);
    }

    log.info(`Done! Total Coles AU products pushed: ${totalPushed}`);
} catch (err) {
    log.exception(err, 'Coles AU actor failed');
    await Actor.fail(err?.message || String(err));
} finally {
    if (browser) await browser.close();
}

await Actor.exit();
